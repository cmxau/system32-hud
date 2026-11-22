import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'system32-hud', component: 'Pane', requestId: 'hud',
  props: { title: 'session', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane draws on the terminal', async ($, on) => {
  on('command.register', () => ({ value: { command: 'hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('session.id', () => ({ value: 'abc' }))
  on('env.get', () => ({ value: '/home/x' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.repo', () => ({ value: { name: 'demo', root: '/', remote: '', internal: false } }))
  on('session.usage', () => ({ value: { startedAt: Date.now() - 60000, context: { window: 200000, tokens: 80000, percent: 40 }, rateLimits: [{ kind: 'five_hour', percentUsed: 24, resetsAt: new Date(Date.now() + 6e6).toISOString() }], cost: { usd: 1.5 } } }))
  on('fs.read', () => { throw new Error('no summary yet') })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeTruthy()
  await ui.unmount()
})
