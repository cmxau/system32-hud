// session-hud mod: session pane (docked right), working line under the spinner, job-complete line, toasts.
// Same flat system24 look as the status line: lowercase, one accent, thin glyphs, no boxes.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, Job, LogEntry, Phase } from '../types'

const PANE = 'hud'
const log = atom({ plugin: 'session-hud', key: 'log' } as const, [] as LogEntry[], { shape: 'log-1' })
const agents = atom({ plugin: 'session-hud', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const jobs = atom({ plugin: 'session-hud', key: 'jobs' } as const, [] as Job[], { shape: 'jobs-1' })
const skills = atom({ plugin: 'session-hud', key: 'skills' } as const, [] as string[], { shape: 'skills-1' }) // invoked this session, newest last
const turnStart = atom({ plugin: 'session-hud', key: 'turnStart' } as const, 0)
const tick = atom({ plugin: 'session-hud', key: 'tick' } as const, 0) // bumped by session.measure so the pane redraws on usage changes

type Summary = { avail: number; pinned?: string[]; today: number; wk: number; todos: [string, string][]; week: { m: string; io: number; usd: number | null }[] }
const C = { acc: '#9cb4d8', ok: '#87af87', warn: '#d7af5f', bad: '#d75f5f', dim: '#767676', fg: '#d0d0d0' }
const PHASE: Record<string, Phase> = { Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'run', Read: 'read', Grep: 'read', Glob: 'read', WebFetch: 'read', WebSearch: 'read', Agent: 'agent', Task: 'agent' }
const VERB: Record<Phase, string> = { edit: 'editing', run: 'running', read: 'reading', agent: 'delegating', other: 'working' }

const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 86400 ? `${Math.floor(s / 86400)}d${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s` }
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const heat = (p: number) => (p < 60 ? C.ok : p < 85 ? C.warn : C.bad)
const bar = (pct: number, w = 10) => { const n = Math.round(Math.min(100, Math.max(0, pct)) / 100 * w); return [heat(pct), '▰'.repeat(n), '▱'.repeat(w - n)] as const }
const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const mini = (v: number, max: number) => ' ' + '▰'.repeat(Math.max(1, Math.round(v / max * 4))).padEnd(4, ' ')
// untrusted text (tool args, skill/agent names, repo names, the summary file) must not carry terminal controls into Ink
const cl = (v: unknown) => String(v ?? '').replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
// the summary file is written by another process: check its shape before use
function parseSummary(raw: string): Summary | null {
  let o: any; try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
  return {
    avail: num(o.avail), today: num(o.today), wk: num(o.wk),
    pinned: arr(o.pinned).filter(x => typeof x === 'string').map(cl).slice(0, 20),
    todos: arr(o.todos).filter(x => Array.isArray(x)).slice(0, 100).map(x => [cl(x[0]), cl(x[1])] as [string, string]),
    week: arr(o.week).filter(x => x && typeof x === 'object').slice(0, 4).map(x => ({ m: cl(x.m), io: num(x.io), usd: typeof x.usd === 'number' && Number.isFinite(x.usd) ? x.usd : null })),
  }
}
const short = (m: string) => cl(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')

function labelOf(tool: string, a: Record<string, unknown>): string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (s('file_path')) return cl(base(s('file_path')))
  if (tool === 'Bash') return cl(s('command')).slice(0, 60) // shown live only; never written to disk
  return cl(s('description') || s('pattern') || s('url') || s('query') || '').slice(0, 60)
}

export const register: Register = on => {
  let live: LogEntry | null = null
  let warned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hud', description: 'Open the session HUD pane' })
    void $.ui.open({ id: PANE, title: 'session' })
    $.clock.every(5000, () => { void update($, tick, n => n + 1) }) // the pane also shows data the status line writes to disk, so redraw with it
    return next(e)
  })
  on('command.run', { command: 'hud' }, async $ => { await $.ui.open({ id: PANE, title: 'session' }); return { text: 'HUD pane opened.' } })

  on('skill.prompt', async ($, e, next) => { await update($, skills, l => [...l.filter(x => x !== cl(e.skill)), cl(e.skill)].slice(-20)); return next(e) })

  on('prompt.submit', async ($, e, next) => { const now = await $.clock.now(); await update($, turnStart, () => now); return next(e) })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    const a = e as unknown as Record<string, unknown>
    const entry: LogEntry = { id: e.tool_use_id, tool: cl(e.tool), label: labelOf(e.tool, a), phase: PHASE[e.tool] ?? 'other', start: now, ms: 0, st: 'run' }
    live = entry
    await update($, log, l => [...l, entry].slice(-150))
    const finish = async (st: 'ok' | 'fail') => {
      const end = await $.clock.now(); if (live === entry) live = null
      await update($, log, l => l.map(x => (x.id === entry.id ? { ...x, st, ms: end - now } : x)))
    }
    try {
      const r = await next(e)
      const bad = 'deny' in r && !!r.deny || (r as { isError?: boolean }).isError === true
      await finish(bad ? 'fail' : 'ok')
      return r
    } catch (err) { await finish('fail'); throw err }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if ('deny' in r && r.deny) return r
    const row: AgentRow = { id: r.agentId ?? e.tool_use_id, type: cl(e.subagentType), desc: cl(e.description ?? ''), model: cl(r.model ?? ''), start: await $.clock.now(), end: 0, st: 'run' }
    await update($, agents, l => [...l, row].slice(-40))
    return r
  })
  on('agent.report', async ($, e, next) => {
    const end = await $.clock.now()
    await update($, agents, l => l.map(x => (x.id === e.agentId ? { ...x, end, st: e.status === 'completed' ? 'done' : 'fail' } : x)))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e) // a subagent's turn, not the main job
    const [l, t0] = await Promise.all([read($, log), read($, turnStart)])
    const mine = l.filter(x => x.start >= t0 - 50)
    const job: Job = { ms: e.durationMs, edits: mine.filter(x => x.phase === 'edit').length, cmds: mine.filter(x => x.phase === 'run').length, errors: mine.filter(x => x.st === 'fail').length, aborted: e.isAborted }
    await update($, jobs, j => [...j, job].slice(-30))
    if (e.durationMs > 120_000) $.ui.toast(`${e.isAborted ? 'stopped' : 'done'} · ${dur(e.durationMs)} · ${job.edits} edits`)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, tick, n => n + 1)
    const p = e.context.percent ?? 0
    if (p >= 80 && !warned) { warned = true; $.ui.toast(`context ${Math.round(p)}% full`) }
    if (p < 60) warned = false
    return next(e)
  })

  // ---------- the pane ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const sid = await $.session.id(), home = await $.env.get('HOME')
    const [model, u, l, ag, sk, now, turns, repo] = await Promise.all([$.session.model(), $.session.usage({ breakdown: 'summary' }), read($, log), read($, agents), read($, skills), $.clock.now(), $.session.turns(), $.session.repo().catch(() => null), read($, tick)])
    let sm: Summary | null = null
    try { sm = parseSummary(await $.fs.read(`${home}/.claude/session-hud/state/${sid.replace(/[^\w-]/g, '')}.summary.json`)) } catch { sm = null }
    const W = Math.max(20, e.props.bodyColumns), rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const H = (s: string, extra = '') => <Text color={C.acc} bold wrap="truncate-end">{`▌ ${s}`}<Text color={C.dim} bold={false}>{extra}</Text></Text>
    const Bar = ({ pct, w }: { pct: number; w?: number }) => { const [c, f, r] = bar(pct, w ?? Math.min(14, W - 10)); return <Text><Text color={c}>{f}</Text><Text color={C.dim}>{r}</Text><Text color={C.fg}>{` ${Math.round(pct)}%`}</Text></Text> }
    const usd = (n: number) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2))

    const ctx = u.context, used = ctx.tokens ?? 0
    const cats = (ctx.breakdown?.categories ?? []).filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 5)
    const win = (k: string, name: string) => { const r = u.rateLimits.find(x => x.kind === k); if (!r) return null
      const ms = r.resetsAt ? Date.parse(r.resetsAt) - now : 0
      return <Box><Text color={C.dim}>{`${name} `}</Text><Bar pct={r.percentUsed} w={8} /><Text color={C.dim}>{ms > 0 ? ` ↻ ${dur(ms)}` : ''}</Text></Box> }

    const running = ag.filter(x => x.st === 'run'), recent = ag.filter(x => x.st !== 'run').slice(-3)
    const files: Record<string, number> = {}
    for (const x of l) if (x.phase === 'edit' && x.label) files[x.label] = (files[x.label] ?? 0) + 1
    const top = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 4), most = top[0]?.[1] ?? 1
    const td = sm?.todos ?? [], tdone = td.filter(x => x[0] === 'completed').length, cur = td.find(x => x[0] === 'in_progress') ?? td.find(x => x[0] === 'pending')
    const pins = (sm?.pinned ?? []).filter(x => !sk.includes(x))
    const wk = sm?.week ?? [], wmax = wk[0]?.io || 1
    const nTools = l.length, nFail = l.filter(x => x.st === 'fail').length
    // activity is already on the main screen: last, and only what room is left
    const room = Math.max(0, Math.min(6, rows - 34 - running.length - top.length - cats.length - wk.length))
    const timeline = l.slice(-room).reverse()

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {H('session')}
          <Text color={C.fg} wrap="truncate-end">{` ${short(model)}`}<Text color={C.dim}>{` · ${turns} turns · ${dur(now - u.startedAt)}`}</Text></Text>
          {repo?.name ? <Text color={C.dim} wrap="truncate-end">{` ${cl(repo.name)}`}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {H('context')}
          {ctx.percent == null ? <Text color={C.dim}> — no response yet</Text> : <Box><Text> </Text><Bar pct={ctx.percent} /></Box>}
          {ctx.percent == null ? null : <Text color={C.dim}>{` ${tok(used)}/${tok(ctx.window)} · ${tok(Math.max(0, ctx.window - used))} left`}</Text>}
          {cats.map(c => <Text wrap="truncate-end"><Text color={C.dim}>{` ${cl(c.name).toLowerCase().slice(0, 14).padEnd(14)} `}</Text><Text color={C.fg}>{tok(c.tokens)}</Text></Text>)}
        </Box>
        <Box flexDirection="column">
          {H('limits')}
          {u.rateLimits.length === 0 ? <Text color={C.dim}> — subscription only</Text> : <Box flexDirection="column">{win('five_hour', ' 5h')}{win('seven_day', ' 7d')}</Box>}
        </Box>
        <Box flexDirection="column">
          {H('cost', '  ~ estimate')}
          <Text color={C.fg}>{` session ${u.cost ? usd(u.cost.usd) : '—'}`}<Text color={C.dim}>{sm ? `  today ${usd(sm.today)}  week ${usd(sm.wk)}` : ''}</Text></Text>
          {wk.map(x => <Text wrap="truncate-end"><Text color={C.acc}>{mini(x.io, wmax)}</Text><Text color={C.fg}>{` ${x.m}`}</Text><Text color={C.dim}>{` ${tok(x.io)}${x.usd == null ? '' : ' ' + usd(x.usd)}`}</Text></Text>)}
        </Box>
        <Box flexDirection="column">
          {H('todos', td.length ? `  ${tdone}/${td.length}` : '')}
          {td.length === 0 ? <Text color={C.dim}> no todo list</Text> : <Text wrap="truncate-end">{cur ? <Text><Text color={C.acc}>{' ▸ '}</Text>{cur[1]}</Text> : <Text color={C.ok}> ✓ all done</Text>}</Text>}
        </Box>
        <Box flexDirection="column">
          {H('skills', `${sk.length ? `  ${sk.length} invoked` : ''}${sm ? `  ${sm.avail} available` : ''}`)}
          {sk.length === 0 && !pins.length ? <Text color={C.dim}> none invoked yet</Text> : null}
          {sk.slice(-5).reverse().map(x => <Text wrap="truncate-end"><Text color={C.ok}>{' ● '}</Text>{x}</Text>)}
          {pins.map(x => <Text wrap="truncate-end" color={C.dim}>{` ○ ${x}  always on`}</Text>)}
        </Box>
        <Box flexDirection="column">
          {H('agents', running.length ? `  ${running.length} running` : '')}
          {running.length + recent.length === 0 ? <Text color={C.dim}> idle</Text> : null}
          {running.map(x => <Text wrap="truncate-end"><Text color={C.acc}>{' ◐ '}</Text>{x.type}<Text color={C.dim}>{` "${x.desc}" ${dur(now - x.start)}`}</Text></Text>)}
          {recent.map(x => <Text wrap="truncate-end" color={C.dim}><Text color={x.st === 'done' ? C.ok : C.bad}>{` ${x.st === 'done' ? '✓' : '✗'} `}</Text>{`${x.type} "${x.desc}" ${dur(x.end - x.start)}`}</Text>)}
        </Box>
        {top.length ? <Box flexDirection="column">
          {H('files', '  most edited')}
          {top.map(([f, n]) => <Text wrap="truncate-end"><Text color={C.acc}>{mini(n, most)}</Text><Text color={C.fg}>{` ${f}`}</Text><Text color={C.dim}>{` ×${n}`}</Text></Text>)}
        </Box> : null}
        {room > 0 ? <Box flexDirection="column">
          {H('activity', `  ${nTools} calls${nFail ? ` · ${nFail} failed` : ''}`)}
          {timeline.map(x => <Text wrap="truncate-end"><Text color={C.dim}>{` ${hhmm(x.start)} `}</Text><Text color={x.st === 'fail' ? C.bad : x.st === 'run' ? C.acc : C.fg}>{x.tool.toLowerCase().padEnd(6).slice(0, 8)}</Text><Text color={C.dim}>{` ${x.label}${x.st === 'run' ? '' : ` ${dur(x.ms)}`}`}</Text></Text>)}
        </Box> : null}
      </Box>
    )
  })

  // ---------- working line under the spinner ----------
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const spinner = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [t0, l, now] = await Promise.all([read($, turnStart), read($, log), $.clock.now()])
    const mode = e.props.mode, tool = mode === 'tool-use' || mode === 'tool-input'
    const phase = tool && live ? live.phase : null
    const what = phase ? VERB[phase] : mode === 'thinking' ? 'thinking' : mode === 'responding' ? 'writing' : 'waiting'
    const ops = l.filter(x => x.start >= t0 - 50).length
    const label = ` ${what}${ops ? ` · ${ops} ops` : ''}${t0 ? ` · ${dur(now - t0)}` : ''}`
    const n = Math.max(8, Math.min(28, (e.viewport?.columns ?? 80) - label.length - 6))
    const pos = Math.floor(now / 90) % (n + 3) - 2 // a short bar sliding along a thin track
    const cells = Array.from({ length: n }, (_, i) => (i >= pos && i < pos + 3 ? '━' : '─'))
    return (
      <Box flexDirection="column">
        {spinner}
        <Box paddingLeft={2}>
          {cells.map(c => <Text color={c === '━' ? C.acc : C.dim}>{c}</Text>)}
          <Text color={C.acc}>{label}</Text>
        </Box>
      </Box>
    )
  })

  // ---------- job-complete line (replaces "Baked for 3s") ----------
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.waitingFor) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const job = [...(await read($, jobs))].reverse().find(j => Math.abs(j.ms - e.props.durationMs) < 1500)
    const tone = !job ? C.ok : job.aborted ? C.warn : job.errors ? C.bad : C.ok
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
    return (
      <Box>
        <Text color={tone} bold>{job?.aborted ? '⏸ ' : job?.errors ? '✗ ' : '✓ '}</Text>
        <Text color={C.fg}>{dur(e.props.durationMs)}</Text>
        {job ? <Text color={C.dim}>{` · ${n(job.edits, 'edit')} · ${n(job.cmds, 'cmd')} · `}</Text> : null}
        {job ? <Text color={job.errors ? C.bad : C.dim}>{n(job.errors, 'error')}</Text> : null}
        {job?.aborted ? <Text color={C.dim}> · interrupted</Text> : null}
      </Box>
    )
  })
}
