# Where each number comes from

| Row | Source | Caveat |
|---|---|---|
| model, effort | status-line JSON `model`, `effort`; `PostModelSwitch` hook | effort is absent on models without it |
| provider | `CLAUDE_CODE_USE_*` env, model id shape, `ANTHROPIC_BASE_URL` | a heuristic; only shown when a non-Anthropic provider is detected |
| ctx | `context_window` | input-only percentage; empty until the first response |
| limits | `rate_limits` | **percent and reset time only**, Pro/Max only, after the first response. Claude Code exposes no token quota |
| cost, session | `cost.total_cost_usd` | Claude Code's own estimate at list price. Not a bill |
| cost today/week, week | `~/.claude/projects/**/*.jsonl` | **derived, this device only**, rolling 7 days, local midnight. The transcript format is undocumented, so unknown lines are skipped. Prices are a table in `src/hud.js`: input/output for current models come from Anthropic's published list; cache-read for some older models and all cache-write rates (1.25x / 2x input) are **assumed**. Unknown models show tokens, no dollars, and are left out of the dollar totals |
| skills | `PreToolUse(Skill)`, `UserPromptExpansion` hooks | **invoked** this session; no "loaded into context" signal. "available" counts SKILL.md dirs (user, project, installed plugins), cached 60s |
| agents | `PreToolUse(Agent)`, `SubagentStart/Stop`, `PostToolUseFailure` hooks | start/stop granularity, no live per-agent tokens. Start events carry no description, so it is joined to the Agent call in order. Running for over an hour counts as stale and is dropped |
| todos | `PreToolUse(TodoWrite)` hook | only works while Claude Code uses `TodoWrite` |
| tools | `PreToolUse` / `PostToolUse` hooks | a tool that is denied or interrupted is dropped after 10 minutes |
| project | status-line `workspace`; `git status` | git runs only when `project` is in `sections` or `dockSections`; cached 5s, 800 ms timeout |

`~` means estimate, `—` means unavailable.
