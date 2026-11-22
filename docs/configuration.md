# Configuration

Config lives in `~/.claude/session-hud.json`. Every key is optional; a missing or unreadable file means all defaults. Values are merged over the defaults below: `bar`, `icons`, `theme` and `skills` merge key by key, all other keys replace the default.

## Defaults

From `DEFAULTS` in `src/hud.js`:

```json
{
  "mode": "auto",
  "density": "default",
  "dockCols": 110,
  "dockSections": ["model", "ctx", "limits"],
  "sections": ["model", "ctx", "limits", "cost", "week", "skills", "agents", "todos", "tools"],
  "bar": { "style": "blocks", "width": 10 },
  "icons": { "run": "◐", "done": "✓", "fail": "✗", "skill": "●", "rest": "↻", "est": "~" },
  "theme": { "dim": "38;5;243", "fg": "38;5;252", "acc": "38;2;156;180;216", "ok": "38;5;108", "warn": "38;5;179", "bad": "38;5;167" },
  "skills": { "pinned": [], "detect": true },
  "color": true
}
```

## Keys

| Key | Values | Notes |
|---|---|---|
| `mode` | `auto`, `rows`, `compact` | `auto`: rows at 90+ columns, one line below, docked trimming at `dockCols`. `rows` and `compact` ignore widths |
| `density` | `default`, `expanded` | `expanded` adds per-model token and cost lines under `week` |
| `dockCols` | number | auto mode only; at this width or wider only `dockSections` show. `0` disables docking |
| `dockSections` | list of section names | shown while docked, plus the todos row if a todo list exists. Include `project` to see git here |
| `sections` | list of section names | order is row order and compact priority; omit a name to hide it. Names: `model`, `ctx`, `limits`, `cost`, `week`, `skills`, `agents`, `todos`, `tools`, `project`, `uptime` (the last two are off by default) |
| `bar.style` | `blocks` (▰▱), `solid` (█░), `ascii` (#-) | unknown values fall back to `blocks` |
| `bar.width` | number | width of ctx and limits bars. The `week` mini bars are fixed at 5 |
| `icons` | `run`, `done`, `fail`, `skill`, `rest`, `est` | single glyphs or short strings |
| `theme` | `dim`, `fg`, `acc`, `ok`, `warn`, `bad` | ANSI SGR parameters such as `38;5;141`. A value that is not digits and semicolons (1 to 40 characters) is ignored and the default is used |
| `skills.pinned` | list of names | always shown as `○ name` |
| `skills.detect` | boolean | also pin skills `CLAUDE.md` declares always on. Matches a sentence like "the `name` skill ... always / by default / active by default"; only the first 64 KB of the user, project and project-`.claude` files are read |
| `color` | boolean | `false` disables color. `NO_COLOR` also disables it |

Keys named `__proto__`, `constructor` or `prototype` are dropped from config and refused by `config`.

The refresh interval is not here: it is `refreshInterval` (seconds) in the statusLine setting, written as 5 by `install`.

## Commands

```
node src/hud.js config preview k=v [k=v ...]
node src/hud.js config set k=v [k=v ...]
node src/hud.js config undo
node src/hud.js replay
node src/hud.js report
node src/hud.js install [--user] [--link]
node src/hud.js uninstall [--user]
```

Keys are dotted paths; a value is parsed as JSON and kept as a string if it does not parse.

```
node src/hud.js config preview mode=compact
node src/hud.js config set bar.width=8 icons.run='"▶"'
node src/hud.js config set sections='["model","ctx","todos"]'
```

| Command | Behavior |
|---|---|
| `config preview` | renders the last real input (`last-input.json`) with the change and saves nothing. Read-only: no summary, scan or cache writes |
| `config set` | the same preview, then copies the current file to `session-hud.json.bak` and writes the new file atomically (0600 if new; an existing file keeps its mode; a symlink is written through to its target). The new file is your existing file plus the changed keys, not the merged defaults |
| `config undo` | restores `session-hud.json.bak` and deletes it, so it reverts only the last `set` |
| `replay` | prints the last status-line input rendered with current config at `$COLUMNS` (100 if unset). Says to send a message first if nothing was captured |
| `report` | like `replay`, plus config and the last input, scrubbed, printed and written to `~/.claude/session-hud/report.md` (0600). See [security](security.md#report) |
| `install` | sets `statusLine` to `node "<hud.js>"` with `refreshInterval: 5`. Without `--user` it edits `./.claude/settings.local.json`; `--user` edits `~/.claude/settings.json`. Copies `hud.js` to `~/.claude/session-hud/hud.js` unless `--link`. Writes `<settings>.hud-bak` first and `prev-statusline.json` if you had another statusLine (not with `--link`). Paths with shell-special characters are single-quoted |
| `uninstall` | restores the saved statusLine if it was saved for that same settings file, otherwise removes `statusLine`. Writes no backup |

`install`, `uninstall` and `config preview|set` print the error and exit 1, changing nothing, when the existing file is not valid JSON or not an object. `install` and `uninstall` refuse a project-local settings symlink (exit 1). `config` also exits 1 for a bad key or a missing `=`. Settings writes are atomic and keep the file's mode (new settings files 0644); `--user` writes through a symlinked `settings.json` to its real target.

## Environment variables

| Variable | Effect |
|---|---|
| `SESSION_HUD_DISABLE` | `1`, `true`, `yes` or `on` (any case) turns off the status-line render (it prints an empty line) and the hooks. Anything else, including `0` and empty, leaves them on. `install`, `uninstall`, `config`, `replay`, `report` and `scan` are unaffected |
| `SESSION_HUD_DEBUG` | exactly `1` makes the hook also append the raw payload of `skill`, `astart`, `astop` and `model` events to `~/.claude/session-hud/debug.jsonl` (0600, appends stop once the file passes 200 KB). Raw payloads can contain prompts and tool inputs; delete the file when done |
| `NO_COLOR` | disables color |
| `COLUMNS` | width used for mode selection; 100 if unset |
| `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `ANTHROPIC_BASE_URL` | read only to label the provider; for the base URL only the host name is used |
