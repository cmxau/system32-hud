export type Phase = 'edit' | 'run' | 'read' | 'agent' | 'other'
export type LogEntry = { id: string; tool: string; label: string; phase: Phase; start: number; ms: number; st: 'run' | 'ok' | 'fail' }
export type AgentRow = { id: string; type: string; desc: string; model: string; start: number; end: number; st: 'run' | 'done' | 'fail' }
export type Job = { ms: number; edits: number; cmds: number; errors: number; aborted: boolean }

declare module 'claude-code' {
  interface PluginState {
    'system32-hud': {
      log: Shaped<LogEntry[]>
      agents: Shaped<AgentRow[]>
      skills: Shaped<string[]>
      jobs: Shaped<Job[]>
      turnStart: number
      tick: number
    }
  }
}
