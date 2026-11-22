const t = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
process.env.NO_COLOR = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-home-')); // keep the render tests out of the real ~/.claude
const h = require('../src/hud.js');

t.test('pricing: known model costs, unknown is null', () => {
  const c = h.cost('claude-opus-5-5', [1e6, 1e6, 0, 0, 0]); assert.equal(c.i + c.o, 24);
  assert.equal(h.cost('claude-mystery-9', [1, 1, 1, 1, 1]), null);
});
t.test('fit truncates by visible width and keeps ansi balanced', () => {
  const r = h.fit('\x1b[31m' + 'x'.repeat(50) + '\x1b[0m', 20); assert.equal(h.vis(r), 20);
});
t.test('short model names', () => assert.equal(h.short('claude-sonnet-5-5'), 'sonnet-5.5'));
t.test('render: rows, compact, missing data', () => {
  const j = { session_id: 'none-x', model: { id: 'claude-opus-5-5' }, effort: { level: 'high' }, context_window: { context_window_size: 2e5, used_percentage: 50 }, cost: { total_cost_usd: 2 } };
  const rows = h.render(j, 105).join('\n');
  for (const k of ['opus-5.5', 'high', '100k/200k', 'session $2.00~', 'limits —', 'agents']) assert.ok(rows.includes(k), k);
  assert.ok(h.render(j, 60).length === 1 && h.vis(h.render(j, 60)[0]) <= 60);
  assert.doesNotThrow(() => h.render({}, 80)); // null context, no rate_limits, no cost
});
t.test('scan dedupes repeated message ids and buckets by model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-')); process.env.HOME = home;
  delete require.cache[require.resolve('../src/hud.js')];
  const hh = require('../src/hud.js'), dir = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(dir, { recursive: true });
  const line = (id, out) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [line('a', 5), line('a', 5), line('b', 7)].join('\n') + '\n');
  hh.scan();
  const L = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'system32-hud', 'ledger.json')));
  const u = Object.values(Object.values(L.days)[0])[0]; assert.deepEqual(u.slice(0, 2), [2, 12]);
  hh.scan(); assert.deepEqual(Object.values(Object.values(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'system32-hud', 'ledger.json'))).days)[0])[0].slice(0, 2), [2, 12]); // rescan is idempotent
});
t.test('provider label', () => {
  assert.equal(h.provider('claude-opus-5-5', { CLAUDE_CODE_USE_BEDROCK: '1' }), 'Bedrock');
  assert.equal(h.provider('us.anthropic.claude-x', {}), 'Bedrock');
  assert.equal(h.provider('claude-x@2025', {}), 'Vertex');
  assert.equal(h.provider('claude-x', { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic' }), 'minimax');
  assert.equal(h.provider('claude-x', {}), '');
});
t.test('todos and tools rows from hook events', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-')); process.env.HOME = home;
  delete require.cache[require.resolve('../src/hud.js')];
  const hh = require('../src/hud.js'), d = path.join(home, '.claude', 'system32-hud', 'state'); fs.mkdirSync(d, { recursive: true });
  const ev = o => JSON.stringify({ t: Date.now(), ...o });
  fs.writeFileSync(path.join(d, 'tt.jsonl'), [ev({ e: 'start' }), ev({ e: 'todos', list: [['completed', 'a'], ['in_progress', 'Fix auth bug'], ['pending', 'c']] }),
    ev({ e: 'tstart', id: '1', n: 'Read', a: 'x.ts' }), ev({ e: 'tend', id: '1' }), ev({ e: 'tstart', id: '2', n: 'Edit', a: 'auth.ts' })].join('\n') + '\n');
  const out = hh.render({ session_id: 'tt' }, 105).join('\n');
  for (const k of ['Fix auth bug', '(1/3)', 'Edit: auth.ts', '✓ Read']) assert.ok(out.includes(k), k);
  assert.equal(hh.toolArg({ file_path: '/a/b/c.ts' }), 'c.ts');
});
t.test('docked: wide terminal trims to one crucial line', () => {
  const j = { session_id: 'none-y', model: { id: 'claude-opus-5-5' }, context_window: { context_window_size: 2e5, used_percentage: 50 }, cost: { total_cost_usd: 2 } };
  const wide = h.render(j, 140); assert.equal(wide.length, 1);
  assert.ok(wide[0].includes('ctx') && !wide[0].includes('cost') && !wide[0].includes('agents'));
  assert.ok(h.render(j, 100).length > 3); // narrower than dockCols: full rows
});
t.test('pinned skills show as always-on, not as invoked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-')); process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'system32-hud.json'), JSON.stringify({ skills: { pinned: ['ponytail'] } }));
  delete require.cache[require.resolve('../src/hud.js')];
  const out = require('../src/hud.js').render({ session_id: 'pp' }, 105).join('\n');
  assert.ok(out.includes('○ ponytail') && out.includes('always on') && !out.includes('none invoked'));
});
t.test('detects always-on skills from CLAUDE.md', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-')); process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'Treat the `ponytail` skill as always active for coding tasks.\nUse `other` skill when asked.\n');
  delete require.cache[require.resolve('../src/hud.js')];
  const hh = require('../src/hud.js');
  assert.deepEqual(hh.detectPinned('/nonexistent'), ['ponytail']);
  assert.ok(hh.render({ session_id: 'dd' }, 105).join('\n').includes('○ ponytail'));
});

// ---------- security hardening
const fresh = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-')); process.env.HOME = home; delete require.cache[require.resolve('../src/hud.js')]; return { home, hh: require('../src/hud.js') }; };
const runHook = (home, payload, env = {}) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'hud.js'), 'hook'], { input: JSON.stringify(payload), env: { ...process.env, HOME: home, ...env } });
t.test('hook: session ids cannot traverse; state is private; debug.jsonl is off by default', () => {
  const { home } = fresh(), S = path.join(home, '.claude', 'system32-hud');
  runHook(home, { session_id: '../../evil', hook_event_name: 'SessionStart', secret: 'PROMPT-TEXT' });
  runHook(home, { session_id: 'ok-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'x' } });
  assert.deepEqual(fs.readdirSync(path.join(S, 'state')).sort(), ['ok-1.jsonl', 'evil.jsonl'].sort());
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'evil.jsonl')) && !fs.existsSync(path.join(S, 'debug.jsonl')));
  assert.equal(fs.statSync(path.join(S, 'state')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(S, 'state', 'ok-1.jsonl')).mode & 0o777, 0o600);
  runHook(home, { session_id: 'ok-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'y' } }, { SYSTEM32_HUD_DEBUG: '1' });
  assert.equal(fs.statSync(path.join(S, 'debug.jsonl')).mode & 0o777, 0o600);
});
t.test('toolArg: Bash commands are never recorded, URL userinfo/query dropped', () => {
  const { hh } = fresh();
  assert.equal(hh.toolArg({ command: 'curl -H "Authorization: Bearer abc" x' }), '');
  assert.equal(hh.toolArg({ url: 'https://u:pw@host.io/a?token=s#f' }), 'https://host.io/a');
  assert.ok(!hh.toolArg({ file_path: '/a/\x1b]0;x\x07b.ts' }).includes('\x1b'));
});
t.test('control characters from untrusted data never reach the output', () => {
  const { home, hh } = fresh(), d = path.join(home, '.claude', 'system32-hud', 'state'); fs.mkdirSync(d, { recursive: true });
  const ev = o => JSON.stringify({ t: Date.now(), ...o }), bad = '\x1b]0;PWNED\x07\x1b[2J\x9b31mX';
  fs.writeFileSync(path.join(d, 'cc.jsonl'), [ev({ e: 'start' }), ev({ e: 'skill', name: 'sk' + bad }), ev({ e: 'todos', list: [['in_progress', 'todo' + bad]] }), ev({ e: 'tstart', id: '1', n: 'T' + bad, a: 'a' + bad }), ev({ e: 'call', id: 'c', desc: 'd' + bad, type: 'ty' + bad }), 'null', '[1]'].join('\n') + '\n');
  const out = hh.render({ session_id: 'cc', model: { id: 'm' + bad }, workspace: { project_dir: '/p' + bad, current_dir: '/p' + bad } }, 105).join('\n');
  assert.ok(out.includes('todo') && out.includes('sk'));
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out), JSON.stringify(out)); // NO_COLOR is set, so any ESC would be an injection
  assert.equal(hh.clean('a\x1b[31mb\nc'), 'a[31mb c');
});
t.test('provider shows only the hostname, never URL credentials', () => {
  const { hh } = fresh(), p = hh.provider('claude-x', { ANTHROPIC_BASE_URL: 'https://user:s3cret@api.minimax.io:8443/anthropic?key=zzz' });
  assert.equal(p, 'minimax'); assert.ok(!/s3cret|user|zzz/.test(p));
});
t.test('config keys: prototype pollution rejected', () => {
  const { hh } = fresh();
  for (const k of ['__proto__.x', 'a.constructor.prototype.y', 'prototype.z', 'a..b']) assert.throws(() => hh.setPath({}, k, 1), /refusing/, k);
  const o = {}; hh.setPath(o, 'bar.width', 4); assert.deepEqual(o, { bar: { width: 4 } }); assert.equal({}.x, undefined);
});
t.test('malformed settings are refused, not clobbered; valid ones are kept', () => {
  const { home, hh } = fresh(), f = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ "permissions": oops'); const err = console.error; console.error = () => {};
  try { hh.install(['--user']); hh.uninstall(['--user']); } finally { console.error = err; process.exitCode = 0; }
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "permissions": oops'); assert.ok(!fs.existsSync(f + '.hud-bak'));
  fs.writeFileSync(f, JSON.stringify({ keep: 1 })); const log = console.log; console.log = () => {};
  try { hh.install(['--user']); } finally { console.log = log; }
  const s = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(s.keep, 1); assert.ok(s.statusLine.command.startsWith('node "'));
});
t.test('statusLine command is shell-quoted when the path is hostile', () => {
  const { hh } = fresh();
  assert.equal(hh.shq('/a b/hud.js'), '"/a b/hud.js"');
  assert.equal(hh.shq('/a$(x)`y`"z\'/h.js'), `'/a$(x)\`y\`"z'\\''/h.js'`);
});
t.test('ledger walk ignores symlinked transcripts and dirs', () => {
  const { home, hh } = fresh(), P = path.join(home, '.claude', 'projects'), out = path.join(home, 'outside'); fs.mkdirSync(path.join(P, 'p'), { recursive: true }); fs.mkdirSync(out);
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'z', model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 9 } } });
  fs.writeFileSync(path.join(out, 'o.jsonl'), line + '\n');
  fs.symlinkSync(out, path.join(P, 'loop')); fs.symlinkSync(P, path.join(P, 'p', 'up')); fs.symlinkSync(path.join(out, 'o.jsonl'), path.join(P, 'p', 'l.jsonl'));
  hh.scan(); const L = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'system32-hud', 'ledger.json')));
  assert.deepEqual(L.days, {}); assert.deepEqual(L.files, {});
});
t.test('report scrubs cwd, transcript path and secrets', () => {
  const { home, hh } = fresh(), D = path.join(home, '.claude', 'system32-hud'); fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, 'last-input.json'), JSON.stringify({ session_id: 'x', cwd: '/srv/acme-secret-proj', transcript_path: '/srv/t/-srv-acme-secret-proj/abc.jsonl', workspace: { project_dir: '/srv/acme-secret-proj', current_dir: '/srv/acme-secret-proj' }, note: 'sk-ant-abcdefghijklmnop' }));
  const log = console.log; let out = ''; console.log = s => { out += s; };
  try { hh.report(); } finally { console.log = log; }
  assert.ok(!/acme|sk-ant|abc\.jsonl/.test(out), out);
});
t.test('detectPinned reads only the first 64 KB', () => {
  const { home, hh } = fresh(); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'always '.repeat(40000) + '\nTreat the `late` skill as always active.\n');
  const t0 = Date.now(); assert.deepEqual(hh.detectPinned('/nonexistent'), []); assert.ok(Date.now() - t0 < 1500);
});
{ // process-level behaviour: run the real script with a throwaway HOME
  const cp = require('child_process'), HUD = path.join(__dirname, '..', 'src', 'hud.js');
  const run = (home, args, o = {}) => cp.spawnSync(process.execPath, [HUD, ...args], { env: { ...process.env, HOME: home, NO_COLOR: '1', ...o.env }, input: o.input || '{}', encoding: 'utf8' });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hud-p-'));
  const input = JSON.stringify({ session_id: 'pp1', model: { id: 'claude-opus-5-5' }, cwd: '/tmp' });

  t.test('SYSTEM32_HUD_DISABLE: only truthy values disable; management commands still work', () => {
    const h = tmp();
    assert.ok(run(h, [], { input, env: { SYSTEM32_HUD_DISABLE: '0' } }).stdout.includes('opus-5.5'));
    assert.equal(run(h, [], { input, env: { SYSTEM32_HUD_DISABLE: '1' } }).stdout.trim(), '');
    assert.ok(run(h, ['config', 'preview', 'mode=compact'], { env: { SYSTEM32_HUD_DISABLE: '1' } }).stdout.includes('preview only'));
  });
  t.test('git only runs when the project section is shown', () => {
    const h = tmp(); run(h, [], { input });
    assert.ok(!fs.existsSync(path.join(h, '.claude', 'system32-hud', 'git.json')));
    fs.writeFileSync(path.join(h, '.claude', 'system32-hud.json'), JSON.stringify({ sections: ['model', 'project'] })); run(h, [], { input });
    assert.ok(fs.existsSync(path.join(h, '.claude', 'system32-hud', 'git.json')));
  });
  t.test('replay is read-only: no summary, no ledger claim, no scan', () => {
    const h = tmp(); const d = path.join(h, '.claude', 'system32-hud'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'last-input.json'), input);
    assert.ok(run(h, ['replay']).stdout.includes('opus-5.5'));
    assert.deepEqual(fs.readdirSync(d), ['last-input.json']);
  });
  t.test('state trim is atomic and keeps the last start event', () => {
    const h = tmp(), st = path.join(h, '.claude', 'system32-hud', 'state'); fs.mkdirSync(st, { recursive: true });
    const f = path.join(st, 'big.jsonl'), line = i => JSON.stringify({ t: i, e: 'tend', id: 'x'.repeat(100) });
    fs.writeFileSync(f, JSON.stringify({ t: 1, e: 'start' }) + '\n' + Array.from({ length: 25000 }, (_, i) => line(i)).join('\n') + '\n');
    run(h, ['hook'], { input: JSON.stringify({ session_id: 'big', hook_event_name: 'PostModelSwitch', to_model: 'claude-opus-5-5' }) });
    const out = fs.readFileSync(f, 'utf8').trim().split('\n');
    assert.ok(out.length <= 1002 && out[0].includes('"e":"start"') && out.at(-1).includes('"e":"model"'));
    assert.deepEqual(fs.readdirSync(st).filter(x => x !== 'big.jsonl'), []); // no temp files left
  });
  t.test('--user install writes through a symlinked settings file atomically', () => {
    const h = tmp(), real = path.join(h, 'dotfiles', 'settings.json'); fs.mkdirSync(path.dirname(real), { recursive: true }); fs.mkdirSync(path.join(h, '.claude'));
    fs.writeFileSync(real, '{"theme":"dark"}'); const link = path.join(h, '.claude', 'settings.json'); fs.symlinkSync(real, link);
    assert.equal(run(h, ['install', '--user', '--link']).status, 0);
    assert.ok(fs.lstatSync(link).isSymbolicLink() && JSON.parse(fs.readFileSync(real, 'utf8')).statusLine.type === 'command' && JSON.parse(fs.readFileSync(real, 'utf8')).theme === 'dark');
  });

  t.test('themes: every preset is complete, overrides are validated, bg only where asked', () => {
    const { THEMES, themeOf } = h;
    assert.ok(Object.keys(THEMES).length >= 11 && ['default', 'monokai', 'abyss', 'solarized', 'matrix'].every(n => THEMES[n]));
    for (const [n, th] of Object.entries(THEMES)) for (const k of ['dim', 'fg', 'acc', 'ok', 'warn', 'bad']) assert.match(th[k], /^#[0-9a-f]{6}$/i, n + '.' + k);
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.deepEqual(themeOf(bad), THEMES.default, bad); // names are looked up as own keys only
    assert.deepEqual(themeOf(undefined), THEMES.default); assert.deepEqual(themeOf('nope'), THEMES.default); assert.deepEqual(themeOf('MONOKAI'), THEMES.monokai);
    assert.equal(themeOf({ name: 'nord', acc: '#ff00ff' }).acc, '#ff00ff');
    assert.equal(themeOf({ name: 'nord', acc: 'red; rm -rf' }).acc, THEMES.nord.acc); // junk ignored
    assert.equal(themeOf('matrix').bg, '#000000'); assert.equal(themeOf({ name: 'matrix', bg: 'none' }).bg, undefined); assert.equal(themeOf('monokai').bg, undefined);
  });
  t.test('themes: colors reach the status line and the summary file; matrix paints full-width rows', () => {
    const j = JSON.stringify({ session_id: 'th1', model: { id: 'claude-opus-5-5' }, context_window: { context_window_size: 2e5, used_percentage: 41 } });
    const h1 = tmp(); fs.mkdirSync(path.join(h1, '.claude'), { recursive: true }); fs.writeFileSync(path.join(h1, '.claude', 'system32-hud.json'), JSON.stringify({ theme: 'monokai' }));
    const env = { NO_COLOR: '', COLUMNS: '50' }, out = run(h1, [], { input: j, env }).stdout;
    assert.ok(out.includes('\x1b[38;2;102;217;239m') && !out.includes('\x1b[48;'), 'monokai accent, no bg');
    const sum = JSON.parse(fs.readFileSync(path.join(h1, '.claude', 'system32-hud', 'state', 'th1.summary.json'), 'utf8')); assert.equal(sum.theme.acc, '#66d9ef');
    fs.writeFileSync(path.join(h1, '.claude', 'system32-hud.json'), JSON.stringify({ theme: 'matrix' }));
    const rows = run(h1, [], { input: j, env }).stdout.trimEnd().split('\n');
    for (const r of rows) assert.ok(r.startsWith('\x1b[48;2;0;0;0m') && h.vis(r) === 50 && r.endsWith('\x1b[0m'), 'row painted and padded to 50');
  });
  t.test('config themes lists presets; theme= and theme.key= edit the config', () => {
    const h2 = tmp(), list = run(h2, ['config', 'themes']).stdout; for (const n of ['monokai', 'abyss', 'solarized', 'matrix', 'default', 'dracula']) assert.ok(list.includes(n), n);
    run(h2, ['config', 'set', 'theme=monokai']); run(h2, ['config', 'set', 'theme.acc=#ff00ff']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h2, '.claude', 'system32-hud.json'), 'utf8')).theme, { name: 'monokai', acc: '#ff00ff' });
  });
}
