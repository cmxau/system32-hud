#!/usr/bin/env node
// session-hud: one file, zero deps. Modes: (default) render status line | hook | scan | install | uninstall | config | replay | report
// SESSION_HUD_DISABLE=1 turns the status line and its hooks off for that process; install/config/replay/report still work.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'session-hud');         // state lives here, not in the plugin dir (survives updates, same path for hooks + renderer)
const STATE = path.join(DIR, 'state'), LEDGER = path.join(DIR, 'ledger.json');
const CFG = path.join(HOME, '.claude', 'session-hud.json');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// state is private: dirs 0700, files 0600, temp file created exclusively (never follows a planted symlink)
const priv = d => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} };
const wrText = (f, text, mode = 0o600) => { priv(path.dirname(f)); const t = f + '.' + process.pid; try { fs.unlinkSync(t); } catch {} fs.writeFileSync(t, text, { mode, flag: 'wx' }); fs.renameSync(t, f); };
const wr = (f, o) => wrText(f, JSON.stringify(o));
// write a file the user owns (settings / config) atomically: through a symlink to its real target, keeping its mode
const wrUser = (f, text, dflt) => { let real = f, mode = dflt; try { real = fs.realpathSync(f); mode = fs.statSync(real).mode & 0o777; } catch {} wrText(real, text, mode); };
const OFF = /^(1|true|yes|on)$/i.test(process.env.SESSION_HUD_DISABLE || ''); // "0"/"" mean enabled
let DRY = false; // replay / report / config preview: read-only, no summary write, no scan, no git cache
// strict JSON object reader for files we may REWRITE (settings): missing -> {}, unparseable/non-object -> throws, so we never clobber it
const rdStrict = f => { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let o; try { o = JSON.parse(t); } catch (e) { throw new Error(`${f} is not valid JSON (${e.message}); fix or remove it first, nothing was changed`); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${f} is not a JSON object; nothing was changed`); return o; };
// untrusted text (hook payloads, transcripts, repo/branch/file names) -> no ESC/C0/C1/bidi controls reach the terminal
const clean = s => String(s ?? '').replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
const safeSid = s => String(s ?? '').replace(/[^\w-]/g, '').slice(0, 100); // the ONE session-id sanitizer (all state paths)
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const noProto = o => { if (Array.isArray(o)) return o.map(noProto); if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) if (!BAD.has(k)) r[k] = noProto(o[k]); return r; } return o; };

// ---------- pricing ($/MTok: in, out, cacheRead). Cache writes assumed 1.25x (5m) / 2x (1h) of input. See README "Where each number comes from".
const PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 40, .2], [/fable-5|mythos-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, .2], [/opus-5|opus-4-[5-8]/, 5, 25, .5],
  [/sonnet-5-5/, 2, 10, .1], [/sonnet-5/, 2, 10, .2], [/sonnet-4-[56]/, 3, 15, .3],
  [/haiku-5/, .1, .5, .01], [/haiku-4-5/, 1, 5, .1],
];
// u = [input, output, cacheRead, cacheWrite5m, cacheWrite1h] -> {i,o,c} USD or null if model unknown
function cost(model, u) {
  const p = PRICES.find(x => x[0].test(model)); if (!p) return null;
  const i = u[0] * p[1] / 1e6, o = u[1] * p[2] / 1e6;
  return { i, o, c: u[2] * p[3] / 1e6 + u[3] * p[1] * 1.25 / 1e6 + u[4] * p[1] * 2 / 1e6 };
}
const total = c => c ? c.i + c.o + c.c : 0;

// ---------- config
const DEFAULTS = {
  mode: 'auto',                       // auto | rows | compact
  density: 'default',                 // default | expanded
  dockCols: 110,                      // auto mode, this wide or wider: the side pane has the detail, keep only dockSections (+ todos) here. 0 = off
  dockSections: ['model', 'ctx', 'limits'],
  sections: ['model', 'ctx', 'limits', 'cost', 'week', 'skills', 'agents', 'todos', 'tools'], // order = row order; add 'project', 'uptime'
  bar: { style: 'blocks', width: 10 }, // blocks ▰▱ | solid █░ | ascii #-
  icons: { run: '◐', done: '✓', fail: '✗', skill: '●', rest: '↻', est: '~' },
  theme: { dim: '38;5;243', fg: '38;5;252', acc: '38;2;156;180;216', ok: '38;5;108', warn: '38;5;179', bad: '38;5;167' },
  skills: { pinned: [], detect: true }, // always-on skills: Claude Code gives no "loaded" signal, so list them (detect: also pick them up from CLAUDE.md)
  color: true,
};
const merge = u => (u = noProto(u && typeof u === 'object' ? u : {}), { ...DEFAULTS, ...u, bar: { ...DEFAULTS.bar, ...u.bar }, icons: { ...DEFAULTS.icons, ...u.icons }, theme: Object.fromEntries(Object.entries({ ...DEFAULTS.theme, ...u.theme }).map(([k, v]) => [k, /^[\d;]{1,40}$/.test(v) ? v : DEFAULTS.theme[k] || '0'])), skills: { ...DEFAULTS.skills, ...u.skills } });
let cfg = merge(rd(CFG, {}));

// ---------- tiny format helpers
const ANSI = /\x1b\[[0-9;]*m/g;
const col = (k, s) => (cfg.color && !process.env.NO_COLOR) ? `\x1b[${cfg.theme[k]}m${s}\x1b[0m` : String(s);
const vis = s => s.replace(ANSI, '').length;
const tok = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const usd = n => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const dur = s => { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const clock = (ms, withDay) => new Intl.DateTimeFormat('en-US', { ...(withDay && { weekday: 'short' }), hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(ms).replace(',', '');
const provider = (m, env = process.env) => env.CLAUDE_CODE_USE_BEDROCK ? 'Bedrock' : env.CLAUDE_CODE_USE_VERTEX ? 'Vertex' : env.CLAUDE_CODE_USE_FOUNDRY ? 'Foundry'
  : /^(\w+\.)?anthropic\./.test(m) ? 'Bedrock' : /@/.test(m) ? 'Vertex'
  : (h => h && !/(^|\.)anthropic\.com$/.test(h) ? h.split('.').slice(-2, -1)[0] || h : '')((() => { try { return new URL(env.ANTHROPIC_BASE_URL).hostname; } catch { return ''; } })());
const short = m => clean(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2').replace(/-\d{8}$/, '');
const BARS = { blocks: ['▰', '▱'], solid: ['█', '░'], ascii: ['#', '-'] };
const bar = (pct, w = cfg.bar.width, k) => { const [f, e] = BARS[cfg.bar.style] || BARS.blocks, n = Math.round(Math.min(100, Math.max(0, pct)) / 100 * w);
  return col(k || heat(pct), f.repeat(n)) + col('dim', e.repeat(w - n)); };
const heat = p => p < 60 ? 'ok' : p < 85 ? 'warn' : 'bad';
const spark = a => { const mx = Math.max(...a, 1e-9); return a.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(v / mx * 7.99))]).join(''); };
const lab = s => col('dim', s.padEnd(7));

function fit(row, cols) { // truncate to visible width, keep ANSI intact
  if (vis(row) <= cols) return row;
  let out = '', n = 0;
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (ANSI.test(part)) { ANSI.lastIndex = 0; out += part; continue; }
    const take = Math.max(0, Math.min(part.length, cols - 1 - n)); out += part.slice(0, take); n += take;
    if (take < part.length) break;
  }
  return out + '…\x1b[0m';
}

// ---------- hooks: append tiny events to state/<session>.jsonl (async hooks, never blocks Claude)
// privacy: Bash commands are never recorded (they carry tokens/passwords); URLs lose userinfo, query and fragment
const toolArg = ti => { ti = ti && typeof ti === 'object' ? ti : {}; let v = ti.file_path || ti.notebook_path || ti.path || ti.pattern || ti.url || ti.query || '';
  if (typeof v !== 'string') return '';
  if (ti.url === v) v = v.replace(/^([a-z][\w+.-]*:\/\/)[^/@?#]*@/i, '$1').replace(/[?#].*$/, '');
  return clean(/^[\\/]|^[~.]/.test(v) && !/\s/.test(v) ? path.basename(v) : v).replace(/\s+/g, ' ').slice(0, 28); };
const str = (v, n = 100) => typeof v === 'string' ? v.slice(0, n) : '';
function hook() {
  if (OFF) return;
  let raw = ''; process.stdin.on('data', d => { if (raw.length < 1e6) raw += d; }).on('end', () => {
    try {
      const j = JSON.parse(raw), sid = safeSid(j.session_id), ev = j.hook_event_name, ti = j.tool_input && typeof j.tool_input === 'object' ? j.tool_input : {}, t = Date.now();
      if (!sid) return;
      let e = null;
      if (ev === 'SessionStart') { e = { e: 'start' }; prune(); }
      else if (ev === 'PreToolUse' && j.tool_name === 'Skill') e = { e: 'skill', name: str(ti.skill || ti.name || ti.command) || '?' };
      else if (ev === 'PreToolUse' && j.tool_name === 'TodoWrite') e = { e: 'todos', list: (Array.isArray(ti.todos) ? ti.todos : []).slice(0, 100).map(x => x = x || {}).map(x => [str(x.status, 20), str(x.activeForm || x.content, 80)]) };
      else if (ev === 'PreToolUse' && !/^(Agent|Task)$/.test(j.tool_name)) e = { e: 'tstart', id: str(j.tool_use_id), n: str(j.tool_name, 60), a: toolArg(ti) };
      else if (ev === 'PostToolUse' && !/^(Agent|Task)$/.test(j.tool_name)) e = { e: 'tend', id: str(j.tool_use_id) };
      else if (ev === 'PreToolUse') e = { e: 'call', id: str(j.tool_use_id), desc: str(ti.description, 200), type: str(ti.subagent_type, 60), model: str(ti.model, 60) };
      else if (ev === 'UserPromptExpansion') e = { e: 'skill', name: str(j.command_name || j.command || j.name) || '?', typed: 1 };
      else if (ev === 'SubagentStart') e = { e: 'astart', aid: str(j.agent_id), type: str(j.agent_type, 60) };
      else if (ev === 'SubagentStop') e = { e: 'astop', aid: str(j.agent_id) };
      else if (ev === 'PostToolUse') e = { e: 'adone', id: str(j.tool_use_id), model: str((j.tool_response || {}).resolvedModel, 60) };
      else if (ev === 'PostToolUseFailure') e = { e: 'afail', id: str(j.tool_use_id) };
      else if (ev === 'PostModelSwitch') e = { e: 'model', to: str(j.to_model, 60) };
      if (!e) return;
      priv(DIR); priv(STATE);
      const sf = path.join(STATE, sid + '.jsonl');
      try { if (fs.statSync(sf).size > 2e6) { // bound growth: newest 1000 lines, always keeping the session's last `start` so fold() still resets correctly
        const ls = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean), st = ls.findLastIndex(l => l.includes('"e":"start"')), keep = ls.slice(-1000);
        if (st >= 0 && st < ls.length - 1000) keep.unshift(ls[st]); wrText(sf, keep.join('\n') + '\n'); } } catch {}
      fs.appendFileSync(sf, JSON.stringify({ t, ...e }) + '\n', { mode: 0o600 });
      // spike aid, OPT-IN only (SESSION_HUD_DEBUG=1): raw payloads can hold prompts, file contents and tool inputs. Capped at 200 KB, 0600.
      if (process.env.SESSION_HUD_DEBUG === '1' && ['skill', 'astart', 'astop', 'model'].includes(e.e)) { const f = path.join(DIR, 'debug.jsonl');
        if (!fs.existsSync(f) || fs.statSync(f).size < 2e5) fs.appendFileSync(f, raw.replace(/\n/g, ' ') + '\n', { mode: 0o600 }); }
    } catch { /* hooks must never fail loudly */ }
  });
}
function prune() { try { for (const f of fs.readdirSync(STATE)) { const p = path.join(STATE, f); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.unlinkSync(p); } } catch {} }

// fold events since last session start into {agents, skills, model, start}
function fold(sid) {
  let lines = []; try { lines = fs.readFileSync(path.join(STATE, safeSid(sid) + '.jsonl'), 'utf8').trim().split('\n'); } catch {}
  const S = { agents: [], skills: new Map(), model: null, start: null, todos: [], run: new Map(), tools: new Map() };
  for (const l of lines) { let e; try { e = JSON.parse(l); } catch { continue; } if (!e || typeof e !== 'object') continue;
    for (const k of ['name', 'n', 'a', 'type', 'desc', 'model', 'to']) if (k in e) e[k] = clean(e[k]); // hook data is untrusted: no terminal controls
    if (e.e === 'start') { S.agents = []; S.skills.clear(); S.model = null; S.start = e.t; S.todos = []; S.run.clear(); S.tools.clear(); }
    else if (e.e === 'todos') S.todos = (Array.isArray(e.list) ? e.list : []).filter(Array.isArray).slice(0, 100).map(x => [clean(x[0]), clean(x[1])]);
    else if (e.e === 'tstart') S.run.set(e.id, e);
    else if (e.e === 'tend') { const r = S.run.get(e.id); if (r) { S.run.delete(e.id); S.tools.set(r.n, (S.tools.get(r.n) || 0) + 1); } }
    else if (e.e === 'skill') { S.skills.delete(e.name); S.skills.set(e.name, e.t); }
    else if (e.e === 'model') S.model = e.to;
    else if (e.e === 'call') S.agents.push({ callId: e.id, type: e.type, desc: e.desc, model: e.model, t: e.t, st: 'queued' });
    else if (e.e === 'astart') { // ponytail: FIFO-join to oldest unmatched call of same type; SubagentStart has no tool_use_id
      const a = S.agents.find(x => x.st === 'queued' && (!e.type || x.type === e.type)) || (S.agents.push({ type: e.type, t: e.t }), S.agents.at(-1));
      Object.assign(a, { aid: e.aid, st: 'run', t: e.t }); }
    else if (e.e === 'astop') { const a = S.agents.find(x => x.aid === e.aid); if (a && a.st !== 'fail') { a.st = 'done'; a.end = e.t; } }
    else if (e.e === 'afail') { const a = S.agents.find(x => x.callId === e.id); if (a) { a.st = 'fail'; a.end = e.t; } }
    else if (e.e === 'adone') { const a = S.agents.find(x => x.callId === e.id); if (a && e.model) a.model = e.model; }
  }
  for (const a of S.agents) if (a.st === 'run' && Date.now() - a.t > 36e5) a.st = 'stale';
  for (const [k, r] of S.run) if (Date.now() - r.t > 6e5) S.run.delete(k); // tool never reported back (denied/interrupted)
  return S;
}

// ---------- ledger: incremental transcript scan -> days[day][model] = [in,out,cacheRead,cw5m,cw1h]
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function walk(dir, out, minM, depth = 0) { let es; if (depth > 6 || out.length > 5000) return; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = path.join(dir, e.name); // Dirent isDirectory/isFile are false for symlinks: links are never followed (no loops, no escapes)
    if (e.isDirectory()) walk(p, out, minM, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs > minM) out.push(p); } catch {} } } }
const addU = (days, d, m, u, s) => { if (m === '__proto__') return; const dm = (days[d] ||= {}), r = Object.hasOwn(dm, m) ? dm[m] : (dm[m] = [0, 0, 0, 0, 0]); u.forEach((v, i) => r[i] += s * v); };
function scan() {
  const L = rd(LEDGER, { files: {}, days: {} }); L.scannedAt = Date.now();
  const files = []; walk(PROJECTS, files, Date.now() - 8 * 864e5);
  for (const f of files) {
    const st = L.files[f] ||= { off: 0 }; let size; try { size = fs.statSync(f).size; } catch { continue; }
    if (size < st.off) { st.off = 0; st.last = null; } // file replaced
    if (size === st.off) continue;
    const buf = Buffer.alloc(Math.min(size - st.off, 32 << 20)); // bounded read per pass; the next scan continues
    let fd; try { fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, buf.length, st.off); } catch { continue; } finally { if (fd != null) fs.closeSync(fd); }
    const txt = buf.toString('utf8'), end = txt.lastIndexOf('\n'); if (end < 0) { if (buf.length === 32 << 20) st.off += buf.length; continue; }
    st.off += Buffer.byteLength(txt.slice(0, end + 1));
    for (const line of txt.slice(0, end).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message; if (o.type !== 'assistant' || !m || !m.usage || !m.model || m.model[0] === '<') continue;
      const us = m.usage, cc = us.cache_creation || {};
      const u = [us.input_tokens || 0, us.output_tokens || 0, us.cache_read_input_tokens || 0,
        cc.ephemeral_5m_input_tokens ?? (us.cache_creation_input_tokens || 0), cc.ephemeral_1h_input_tokens || 0];
      // one API message is written once per content block with the same id: replace, don't add
      if (st.last && st.last.id === m.id) addU(L.days, st.last.day, st.last.m, st.last.u, -1);
      const day = dayKey(o.timestamp || Date.now()); addU(L.days, day, m.model, u, 1);
      st.last = { id: m.id, day, m: m.model, u };
    }
  }
  const cut = dayKey(Date.now() - 14 * 864e5); for (const d of Object.keys(L.days)) if (d < cut) delete L.days[d];
  for (const f of Object.keys(L.files)) if (!files.includes(f)) delete L.files[f];
  wr(LEDGER, L);
}
// render never scans inline; it kicks a detached scan when the ledger is stale
function ledger() {
  const L = rd(LEDGER, null);
  if (!DRY && (!L || Date.now() - L.scannedAt > 30e3)) {
    wr(LEDGER, { ...(L || { files: {}, days: {} }), scannedAt: Date.now() }); // claim the slot so concurrent renders don't pile up
    try { cp.spawn(process.execPath, [__filename, 'scan'], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
  return L;
}

// ---------- skills available (cached 60s)
function availSkills(cwd) {
  const f = path.join(DIR, 'skills-count.json'), c = rd(f, null);
  if (c && c.cwd === cwd && Date.now() - c.t < 6e4) return c.n;
  const roots = [path.join(HOME, '.claude', 'skills'), path.join(cwd || '.', '.claude', 'skills')];
  const reg = (rd(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), {}) || {}).plugins || {};
  for (const v of Object.values(reg)) for (const i of Array.isArray(v) ? v : []) if (i && typeof i.installPath === 'string') roots.push(path.join(i.installPath, 'skills'));
  let n = 0; for (const r of roots) { try { for (const e of fs.readdirSync(r)) if (fs.existsSync(path.join(r, e, 'SKILL.md'))) n++; } catch {} }
  if (!DRY) try { wr(f, { cwd, t: Date.now(), n }); } catch {}
  return n;
}

// skills a CLAUDE.md declares always on: "... the `ponytail` skill as always active / by default". Heuristic, one sentence at a time.
function detectPinned(cwd) {
  const out = new Set(), re = /`([\w:.-]+)`\s+skill\b[^.\n]{0,300}\b(?:always|by default|active by default)\b|\b(?:always|by default)\b[^.\n]{0,300}\bskill\s+`([\w:.-]+)`/gi;
  for (const f of [path.join(HOME, '.claude', 'CLAUDE.md'), path.join(cwd || '.', 'CLAUDE.md'), path.join(cwd || '.', '.claude', 'CLAUDE.md')]) {
    let t, fd; try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(65536); t = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); } catch { continue; } finally { if (fd != null) fs.closeSync(fd); } // first 64 KB only
    for (const m of t.replace(/\n(?!\n)/g, ' ').matchAll(re)) out.add(clean(m[1] || m[2])); }
  return [...out];
}

// ---------- render
const sgrOnly = r => r.replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]|\x1b(?!\[[0-9;]*m)/g, ''); // last line of defence: the only ESC allowed out is our own SGR color
function render(j, cols) { return render0(j, cols).map(sgrOnly); }
function render0(j, cols) {
  const S = fold(safeSid(j.session_id) || 'none'), L = ledger(), days = (L && L.days) || {};
  const ex = cfg.density === 'expanded', E = cfg.icons;
  const sel = clean((j.model || {}).id || '?'), wsd = j.workspace || {}, cwd = typeof (j.cwd || wsd.current_dir) === 'string' ? j.cwd || wsd.current_dir : '';
  const R = {}, C = {}; // section -> row (string) / compact segment

  // model + effort
  const eff = clean((j.effort || {}).level), fast = j.fast_mode ? ' ⚡' : '';
  const diff = S.model && sel && S.model !== sel ? col('warn', ` ⇢ ${short(S.model)}`) : '';
  C.model = col('acc', short(sel)) + (eff ? col('dim', ' · ') + col('fg', eff) : '') + fast + diff;
  const prov = provider(sel); if (prov) C.model += col('dim', ` [${prov}]`);
  R.model = col('acc', '▌ ') + C.model;

  // context
  const cw = j.context_window || {}, size = cw.context_window_size, pct = cw.used_percentage;
  if (pct == null || !size) { C.ctx = col('dim', 'ctx —'); R.ctx = C.ctx + col('dim', '  (no API response yet)'); }
  else { const used = Math.round(size * pct / 100);
    C.ctx = col('dim', 'ctx ') + bar(pct) + ` ${Math.round(pct)}%`;
    R.ctx = C.ctx + col('dim', `  ${tok(used)}/${tok(size)}  `) + col('fg', tok(size - used)) + col('dim', ' left'); }

  // limits (subscription windows) — percentages only, that is all Claude Code exposes
  const rl = j.rate_limits, win = (k, n, day) => { const w = rl && rl[k]; if (!w || w.resets_at == null) return null; const ms = w.resets_at * 1000;
    return col('dim', n + ' ') + bar(w.used_percentage) + ` ${Math.round(w.used_percentage)}%` + col('dim', ` ${E.rest} ${dur((ms - Date.now()) / 1000)} (${clock(ms, day)})`); };
  const h5 = win('five_hour', '5h'), d7 = win('seven_day', '7d', true);
  C.limits = rl && rl.five_hour ? col('dim', '5h ') + `${Math.round(rl.five_hour.used_percentage)}%` + col('dim', ` ${E.rest} ${dur((rl.five_hour.resets_at * 1000 - Date.now()) / 1000)}`) : col('dim', 'limits —');
  R.limits = [h5, d7].filter(Boolean).join(col('dim', '   │   ')) || col('dim', 'limits —  (subscription windows appear for Pro/Max after the first response)');
  if (rl && rl.spend_limit) R.limits += col('dim', `   spend ${Math.round(rl.spend_limit.used_percentage)}%`);

  // cost: session = Claude Code's own estimate; today/week = ledger × shipped price table
  const wk = [...Array(7)].map((_, i) => dayKey(Date.now() - (6 - i) * 864e5));
  const perModel = Object.create(null); const dayCost = wk.map(d => { let s = 0;
    for (const [m, u] of Object.entries(days[d] || {})) { if (m === '__proto__' || !Array.isArray(u)) continue; const c = cost(m, u); s += total(c); const p = perModel[m] ||= { u: [0, 0, 0, 0, 0], i: 0, o: 0, c: 0, known: !!c };
      u.forEach((v, i) => p.u[i] += v); if (c) { p.i += c.i; p.o += c.o; p.c += c.c; } }
    return s; });
  const wkTotal = dayCost.reduce((a, b) => a + b, 0), sess = (j.cost || {}).total_cost_usd;
  C.cost = col('dim', 'cost ') + (sess != null ? col('fg', usd(sess) + E.est) : '—');
  R.cost = lab('cost') + `session ${sess != null ? usd(sess) + E.est : '—'}  today ${L ? usd(dayCost[6]) + E.est : '…'}  week ${L ? usd(wkTotal) + E.est : '…'}` +
    col('dim', `   ${E.est} estimate at list price, not a bill`);

  // weekly per-model usage (rolling 7d, from local transcripts)
  const ms = Object.entries(perModel).map(([m, p]) => ({ m, p, io: p.u[0] + p.u[1] })).sort((a, b) => b.io - a.io);
  if (!L) R.week = lab('week') + col('dim', 'scanning transcripts…');
  else if (!ms.length) R.week = lab('week') + col('dim', 'no usage found in the last 7 days');
  else { const mx = ms[0].io || 1;
    R.week = lab('week') + ms.slice(0, 3).map(x => `${short(x.m)} ${bar(x.io / mx * 100, 5, 'acc')} ${tok(x.io)}${x.p.known ? ' ' + usd(x.p.i + x.p.o + x.p.c) + E.est : ''}`).join(col('dim', '  ·  '))
      + (ms.length > 3 ? col('dim', ` +${ms.length - 3}`) : '') + '  ' + col('acc', spark(dayCost));
    if (ex) R.week += '\n' + ms.slice(0, 3).map(x => col('dim', '       ') + `${short(x.m)} ` + col('dim', `in ${tok(x.p.u[0])} out ${tok(x.p.u[1])} cache-r ${tok(x.p.u[2])} cache-w ${tok(x.p.u[3] + x.p.u[4])}`) + (x.p.known ? col('dim', `  $ in ${usd(x.p.i)} out ${usd(x.p.o)} cache ${usd(x.p.c)}`) : col('dim', '  (no price for this model)'))).join('\n'); }
  C.week = ms.length ? col('dim', 'wk ') + usd(wkTotal) + E.est : '';

  // skills: "invoked" this session (Claude Code exposes no "loaded into context" signal)
  const names = [...S.skills.keys()].reverse(), n = availSkills(cwd);
  const pins = [...new Set([...(Array.isArray(cfg.skills.pinned) ? cfg.skills.pinned : []).map(clean), ...(cfg.skills.detect ? detectPinned(cwd) : [])])].filter(k => !names.includes(k));
  C.skills = col('dim', 'skills ') + ((names.length + pins.length) ? col('ok', E.skill) + (names.length + pins.length) : '0');
  const inv = names.slice(0, 4).map(k => col('ok', E.skill) + k), pin = pins.map(k => col('dim', '○ ' + k));
  R.skills = lab('skills') + (inv.length || pin.length ? [...inv, ...pin].join('  ') + (names.length > 4 ? col('dim', ` +${names.length - 4}`) : '') + (pin.length ? col('dim', '  ○ always on') : '') : col('dim', 'none invoked yet')) + col('dim', `    ${n} available`);

  // agents
  const run = S.agents.filter(a => a.st === 'run' || a.st === 'queued'), done = S.agents.filter(a => a.st === 'done').length, fail = S.agents.filter(a => a.st === 'fail').length;
  C.agents = col('dim', 'agents ') + (run.length ? col('acc', E.run) + run.length : '0');
  R.agents = lab('agents') + (run.length ? `${run.length} running  ` + run.slice(0, 3).map(a => `${col('acc', E.run)} ${a.type || 'agent'}${a.desc ? ` "${a.desc}"` : ''}${a.model ? col('dim', ` [${short(a.model)}]`) : ''} ${col('dim', dur((Date.now() - a.t) / 1000))}`).join('  ') + (run.length > 3 ? col('dim', ` +${run.length - 3}`) : '')
    : col('dim', 'idle')) + (done ? col('ok', `  ${E.done}${done}`) : '') + (fail ? col('bad', `  ${E.fail}${fail}`) : '');

  // todos (TodoWrite) and tool activity (running + completed counts)
  const td = S.todos, dn = td.filter(x => x[0] === 'completed').length, cur = td.find(x => x[0] === 'in_progress') || td.find(x => x[0] === 'pending');
  C.todos = td.length ? col('dim', 'todo ') + `${dn}/${td.length}` : '';
  R.todos = lab('todos') + (td.length ? (cur ? `${col('acc', '▸')} ${cur[1]} ` : col('ok', E.done + ' all done ')) + col('dim', `(${dn}/${td.length})`) : col('dim', 'no todo list'));
  const trun = [...S.run.values()].slice(-3), tdone = [...S.tools].sort((a, b) => b[1] - a[1]).slice(0, 4);
  C.tools = trun.length ? col('acc', E.run) + ' ' + trun.at(-1).n : '';
  R.tools = lab('tools') + (trun.length || tdone.length ? [...trun.map(r => `${col('acc', E.run)} ${r.n}${r.a ? ': ' + r.a : ''}`), ...tdone.map(([n, c]) => `${col('ok', E.done)} ${n}${c > 1 ? ' ×' + c : ''}`)].join(col('dim', ' | ')) : col('dim', 'idle'));

  // optional
  const pdir = clean(wsd.project_dir || j.cwd || ''), cdir = clean(wsd.current_dir || j.cwd || '');
  C.project = col('dim', path.basename(pdir));
  R.project = lab('proj') + path.basename(pdir) + col('dim', '  ' + cdir) + ([...cfg.sections, ...cfg.dockSections].includes('project') ? gitInfo(cwd) : ''); // git only runs when the project section can show
  const up = S.start ? (Date.now() - S.start) / 1000 : (j.cost || {}).total_duration_ms / 1000;
  C.uptime = col('dim', 'up ') + (up ? dur(up) : '—'); R.uptime = lab('up') + (up ? dur(up) : '—') + col('dim', '  session wall-clock');

  if (!DRY && safeSid(j.session_id)) try { wr(path.join(STATE, safeSid(j.session_id) + '.summary.json'), { // read by the side pane (it has no transcript/hook access of its own)
    avail: n, pinned: pins, today: dayCost[6], wk: wkTotal, todos: S.todos,
    week: ms.slice(0, 4).map(x => ({ m: short(x.m), io: x.io, usd: x.p.known ? x.p.i + x.p.o + x.p.c : null })) }); } catch {}
  const docked = cfg.mode === 'auto' && cfg.dockCols && cols >= cfg.dockCols;
  const mode = docked ? 'compact' : cfg.mode === 'auto' ? (cols >= 90 ? 'rows' : 'compact') : cfg.mode;
  if (mode === 'rows') return cfg.sections.flatMap(s => (R[s] || '').split('\n')).filter(Boolean).map(r => fit(r, cols));
  // compact: first-listed sections win; drop whole segments that don't fit
  let line = '';
  for (const s of docked ? cfg.dockSections : cfg.sections) { const seg = C[s]; if (!seg) continue; const nx = line ? line + col('dim', ' │ ') + seg : seg; if (vis(nx) <= cols) line = nx; }
  return docked && S.todos.length ? [line, R.todos] : [line]; // todos are not in the pane, so they stay when there is a list
}
function gitInfo(cwd) { // cached 5s
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return ''; // also rules out a '-'-leading value (and -C takes it as a directory anyway)
  const f = path.join(DIR, 'git.json'), c = rd(f, null); if (c && c.cwd === cwd && Date.now() - c.t < 5e3) return c.s;
  let s = ''; try { const o = cp.execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'status', '--porcelain=v1', '-b'], { encoding: 'utf8', timeout: 800, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }).split('\n');
    const br = clean(o[0].replace(/^## /, '').split('...')[0]), mod = o.slice(1).filter(l => l && !l.startsWith('??')).length, unt = o.filter(l => l.startsWith('??')).length;
    s = col('acc', `  ⎇ ${br}`) + col('dim', ` ~${mod} ?${unt}`); } catch {}
  if (!DRY) try { wr(f, { cwd, t: Date.now(), s }); } catch {}
  return s;
}

// ---------- install / uninstall (plugins cannot ship a statusLine, so this edits settings with a backup)
function settingsFile(args) { return args.includes('--user') ? path.join(HOME, '.claude', 'settings.json') : path.join(process.cwd(), '.claude', 'settings.local.json'); }
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const unlink = p => { if (isLink(p)) fs.unlinkSync(p); }; // replace a symlink, never write through it
// shell-safe command: keep the familiar "..." form when the path has no shell-special chars, else POSIX single quotes
const shq = p => process.platform === 'win32' || !/["$`\\'!]/.test(p) ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
const fail = e => { console.error('session-hud: ' + e.message); process.exitCode = 1; };
function install(args) {
  const f = settingsFile(args), prev = path.join(DIR, 'prev-statusline.json');
  let s; try { s = rdStrict(f); } catch (e) { return fail(e); } // a malformed settings file is refused, never replaced with {}
  if (!args.includes('--user') && isLink(f)) return fail(new Error(f + ' is a symlink; refusing to write through it'));
  let target = __filename;
  if (!args.includes('--link')) { target = path.join(DIR, 'hud.js'); priv(DIR); unlink(target); fs.copyFileSync(__filename, target); }
  if (fs.existsSync(f)) { unlink(f + '.hud-bak'); fs.copyFileSync(f, f + '.hud-bak'); }
  if (s.statusLine && !/session-hud/.test(JSON.stringify(s.statusLine)) && !args.includes('--link')) wr(prev, { file: f, statusLine: s.statusLine });
  s.statusLine = { type: 'command', command: `node ${shq(target)}`, refreshInterval: 5 };
  fs.mkdirSync(path.dirname(f), { recursive: true }); wrUser(f, JSON.stringify(s, null, 2) + '\n', 0o644);
  console.log(`session-hud statusLine -> ${f}` + (fs.existsSync(f + ".hud-bak") ? `\nbackup: ${f}.hud-bak` : ""));
}
function uninstall(args) {
  const f = settingsFile(args), p = rd(path.join(DIR, 'prev-statusline.json'), null); let s; try { s = rdStrict(f); } catch (e) { return fail(e); }
  if (!fs.existsSync(f)) return console.log('nothing to remove: ' + f + ' does not exist');
  if (!args.includes('--user') && isLink(f)) return fail(new Error(f + ' is a symlink; refusing to write through it'));
  if (p && p.file === f && p.statusLine && typeof p.statusLine === 'object') s.statusLine = p.statusLine; else delete s.statusLine;
  wrUser(f, JSON.stringify(s, null, 2) + '\n', 0o644); console.log('session-hud removed from ' + f);
}

// ---------- config tooling: preview / set / undo, replay the last real render, scrubbed report
const LAST = path.join(DIR, 'last-input.json');
const setPath = (o, k, v) => { const p = k.split('.'); if (p.some(x => !x || BAD.has(x))) throw new Error(`refusing key "${k}"`); const l = p.pop();
  for (const x of p) o = (Object.hasOwn(o, x) && o[x] && typeof o[x] === 'object') ? o[x] : (o[x] = {}); o[l] = v; };
function configCmd([sub, ...kv]) {
  const bak = CFG + '.bak';
  if (sub === 'undo') { if (!fs.existsSync(bak)) return console.log('nothing to undo'); fs.copyFileSync(bak, CFG); fs.unlinkSync(bak); return console.log('restored previous ' + CFG); }
  if (sub !== 'set' && sub !== 'preview') return console.log('usage: config preview|set key=value ... | config undo   (keys dotted, values JSON, e.g. mode=compact bar.width=8 sections=\'["model","ctx","todos"]\')');
  let u; try { u = rdStrict(CFG); } catch (e) { return fail(e); }
  const next = noProto(u);
  try { for (const a of kv) { const i = a.indexOf('='); if (i < 1) throw new Error(`expected key=value, got "${a}"`); let v = a.slice(i + 1); try { v = JSON.parse(v); } catch {} setPath(next, a.slice(0, i), noProto(v)); } } catch (e) { return fail(e); }
  cfg = merge(next); console.log(replay().join('\n'));
  if (sub === 'set') { if (fs.existsSync(CFG)) fs.copyFileSync(CFG, bak); wrUser(CFG, JSON.stringify(next, null, 2) + '\n', 0o600); console.log('\nsaved ' + CFG + ' (undo: config undo)'); }
  else console.log('\n(preview only, nothing saved)');
}
function replay() { DRY = true; const j = rd(LAST, null); return j ? render(j, +process.env.COLUMNS || 100) : ['no render captured yet; send a message first']; }
function report() {
  const j = rd(LAST, {}) || {}, w = j.workspace || {};
  const dirs = [j.cwd, w.current_dir, w.project_dir, ...(Array.isArray(w.added_dirs) ? w.added_dirs : [])].filter(x => typeof x === 'string' && x.length > 1).sort((a, b) => b.length - a.length);
  const scrub = t => { for (const d of dirs) t = t.split(d).join('<cwd>');
    return t.split(HOME).join('~').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<id>').replace(/\/(?:Users|home)\/[^/\s"]+/g, '/<user>')
      .replace(/\b(?:sk-[\w-]{10,}|gh[pousr]_\w{10,}|xox[abprs]-[\w-]{10,}|AKIA\w{12,}|eyJ[\w-]{15,}\.[\w-]+\.[\w-]+)/g, '<secret>')
      .replace(/(\b(?:Bearer|Basic)\s+)[\w.~+/=-]{8,}/gi, '$1<secret>'); };
  if ('transcript_path' in j) j.transcript_path = '<transcript>';
  delete j.tool_input; delete j.tool_response; delete j.prompt; // never expected here, never included
  const out = scrub(['# session-hud report', `node ${process.version} ${process.platform}`, 'config: ' + JSON.stringify(rd(CFG, {})),
    'last input: ' + JSON.stringify(j), 'render:', ...replay().map(l => l.replace(ANSI, ''))].join('\n'));
  const f = path.join(DIR, 'report.md'); priv(DIR); unlink(f); fs.writeFileSync(f, out + '\n', { mode: 0o600 }); console.log(out + '\n\nwritten to ' + f + ' (scrubbed; read it before sharing anywhere; nothing is sent)');
}

// ---------- main
const [mode, ...args] = process.argv.slice(2);
if (require.main === module) {
  if (OFF && (!mode || mode === 'hook')) { if (!mode) console.log(''); }
  else if (mode === 'hook') hook();
  else if (mode === 'config') configCmd(args);
  else if (mode === 'replay') console.log(replay().join('\n'));
  else if (mode === 'report') report();
  else if (mode === 'scan') scan();
  else if (mode === 'install') install(args);
  else if (mode === 'uninstall') uninstall(args);
  else { let raw = ''; process.stdin.on('data', d => { if (raw.length < 1e6) raw += d; }).on('end', () => {
    try { const j = JSON.parse(raw || '{}'); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('bad input'); try { wr(LAST, j); } catch {} console.log(render(j, +process.env.COLUMNS || 100).join('\n')); }
    catch (e) { console.log(col('dim', 'session-hud: ' + e.message)); } }); }
}
module.exports = { clean, safeSid, setPath, rdStrict, shq, install, uninstall, configCmd, report, detectPinned, provider, toolArg, cost, fit, render, scan, vis, short };
