# Troubleshooting

First look: `node src/hud.js replay` re-renders the last status-line input with your current config, without writing anything. If it prints `no render captured yet`, the status line has never run (see "Blank HUD").

## Blank HUD

1. **Not installed.** Plugins cannot ship a statusLine. Run `node <plugin>/src/hud.js install [--user]` or say "set up system32-hud", then restart Claude Code or send a message. Check that the settings file has a `statusLine` whose command runs `hud.js`.
2. **Wrong settings file.** Without `--user`, `install` edits `./.claude/settings.local.json` in the directory you ran it from. It applies to that project only.
3. **Disabled.** `SYSTEM32_HUD_DISABLE` set to `1`, `true`, `yes` or `on` (any case) makes the render print an empty line. `0` or empty does not.
4. **Node missing or too old.** The command is `node "<path>"`; `node` must be on the PATH Claude Code uses.
5. **A leftover copy.** `install` copies `hud.js` to `~/.claude/system32-hud/hud.js`, and the statusLine runs that copy. If you moved or deleted it, or you installed with `--link` and moved the checkout, re-run `install`.
6. **A one-line dim message** such as `system32-hud: bad input` means the status line got input that was not a JSON object.
7. **Compare against the sample.** Using a scratch home so nothing real is touched:
   ```
   export HOME=$(mktemp -d); now=$(date +%s)
   sed "s/%FIVE%/$((now+6000))/; s/%SEVEN%/$((now+200000))/" tests/sample.json | COLUMNS=100 node src/hud.js
   ```

## The HUD does not update after a plugin update

The hooks run from the plugin, but the status line runs the snapshot copied by `install`. Run `install` again (same `--user` choice).

## `limits —`

The 5h and 7d rows come only from `rate_limits` in the status-line JSON, which Claude Code sends for Pro and Max subscriptions after the first API response. On API-key billing, Bedrock or Vertex, or before the first response, there is no data and the HUD shows `limits —`. It cannot show token quotas; Claude Code does not expose one.

`ctx —` likewise means no API response yet.

## Stale or odd numbers

| Symptom | Cause |
|---|---|
| `week` says `scanning transcripts…` | no ledger yet; the first scan is running. It fills in within a refresh or two |
| today/week lag a little | the scan runs detached, at most every 30 s, and render uses the ledger it already has |
| today/week lower than your real spend | models with no price entry show tokens but no dollars and are excluded from totals; usage is counted for this device only; transcripts older than 8 days are not read |
| week shows nothing for a model | transcripts without usage fields, or unrecognized lines, are skipped |
| session cost differs from today | session is Claude Code's own figure; today is derived from transcripts and the price table |
| skills show `none invoked yet` though one is active | only invocations are tracked; list always-on skills in `skills.pinned` or let `skills.detect` find them in `CLAUDE.md` |
| a tool or agent stays "running" | a denied or interrupted tool is dropped after 10 minutes; an agent running over an hour is treated as stale |
| todos missing | only `TodoWrite` is read |
| agent descriptions missing or swapped | `SubagentStart` has no description, so it is matched to the oldest queued call of the same type |
| nothing after a session was resumed | the fold restarts at the last `SessionStart` event in that session's log |

To reset: delete `~/.claude/system32-hud/ledger.json` (rebuilt by the next scan) or the whole directory (state, caches and the installed `hud.js`, so re-run `install` afterwards).

## `/hud` shows no pane

`/hud` prints what Claude Code answered when asked to open the pane:

- `hud pane open`: it is placed. If you still see nothing, widen the terminal; the dock needs fullscreen rendering at 110+ columns, otherwise it sits inline above the prompt.
- `hud pane not placed: <reason>`: Claude Code accepted the pane but has no room or surface for it; the reason is its own.
- `hud pane refused: <message>`: another plugin already holds a pane with this id, or the open was rejected; the message names why.
- No answer at all, or "unknown command": the plugin's mod is not loaded. Check `claude plugin list`, restart Claude Code, or start with `claude --plugin-dir <checkout>`.

The automatic open at session start only seats from 144 columns; `/hud` is a request from you and seats at any width.

## Pane not docked, or the bottom is too short

- The mod opens the pane at session start; `/hud` opens it again. Whether it docks beside the chat is decided by Claude Code, not by this plugin.
- At `dockCols` (110) or wider the status line trims itself to `dockSections` on the assumption that the pane is open. If it is not, set `"dockCols": 0` or `"mode": "rows"` (`node src/hud.js config set dockCols=0`).
- Width comes from `$COLUMNS`, 100 if unset. If it is wrong in your setup, use `mode=rows` or `mode=compact`, which ignore width.
- Pane blocks for week, todos and skills-available stay empty until the status line has run once, because they come from `state/<sid>.summary.json`.
- The pane hides `activity` when the terminal is short.
- The mod only loads if the plugin is enabled (`claude plugin validate .` checks the manifest).

## Settings or config refusal

```
system32-hud: /path/settings.local.json is not valid JSON (...); fix or remove it first, nothing was changed
```

`install`, `uninstall` and `config preview|set` exit 1 and change nothing when the existing file does not parse or is not a JSON object (an array, for example). Claude Code's own settings files are JSON, not JSON with comments; remove comments and trailing commas, or move the file aside and run `install` to create a new one.

```
system32-hud: /path/.claude/settings.local.json is a symlink; refusing to write through it
```

Raised by `install` and `uninstall` for a project-local settings file that is a symlink. Replace the link with a real file, or use `--user`. With `--user`, a symlinked `settings.json` is allowed: the real target is updated in place.

Other `config` exits: `refusing key "..."` (empty segment, `__proto__`, `constructor`, `prototype`) and `expected key=value`.

Undo trail: the settings file has `.hud-bak` beside it (the copy from just before the last `install`); `config set` leaves `system32-hud.json.bak`; `uninstall` restores the statusLine saved in `~/.claude/system32-hud/prev-statusline.json` if it was saved for the same file.

## Using replay and report

- `replay` shows what the status line would print for the last real input at `$COLUMNS`. Try widths: `COLUMNS=80 node src/hud.js replay`, `COLUMNS=120 ...`.
- `config preview k=v` shows a change on that same input, saving nothing.
- `replay`, `report` and `config preview` write no summary, ledger claim, scan or caches, so they are safe to run any time (`report` writes `report.md`).
- `report` prints and saves a scrubbed report: node version, config, last input, render. Read it before pasting it into an issue; todo text, file names and skill names are not scrubbed. Details: [security](security.md#report).
- To capture hook payloads while chasing a missing event, run Claude Code with `SYSTEM32_HUD_DEBUG=1` and read `~/.claude/system32-hud/debug.jsonl`. It holds raw prompts and tool inputs: do not share it, and delete it afterwards.
