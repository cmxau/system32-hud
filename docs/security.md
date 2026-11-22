# Security and privacy

## Threat model

session-hud runs as you, on your machine, inside your Claude Code session. It has no network code. The assets are what the files it reads and writes could leak, and your terminal and settings files, which it must not corrupt.

Untrusted input, in order of concern:

| Input | Why it is untrusted |
|---|---|
| hook payloads | contain tool inputs, prompts and model output; file and agent names can be attacker-chosen (a repo, a fetched page) |
| transcripts | same content, parsed from files on disk |
| repo, branch and file names, `CLAUDE.md` text | controlled by whoever authored the repo |
| the summary file and event logs | written by another process; the pane and `fold()` re-validate them |
| status-line JSON | from Claude Code, but fields such as model id and cwd flow into output |

Trusted: `$HOME`, the user's own `~/.claude`, the plugin install and the Claude Code binary. See [not covered](#deliberately-not-covered).

## What is read

- the status-line JSON on stdin and hook payloads on stdin (each capped at 1 MB);
- transcripts under `~/.claude/projects` (assistant usage fields only; message text is not kept);
- `~/.claude/skills`, `<cwd>/.claude/skills`, installed plugins' `skills/` directories (names only), `~/.claude/plugins/installed_plugins.json`;
- up to 64 KB each of `~/.claude/CLAUDE.md`, `<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md`, matched against one regex for always-on skill names;
- `git status` output, when `project` is enabled.

## What is written

Only these paths; nothing is sent anywhere.

| Path | Mode | Content |
|---|---|---|
| `~/.claude/session-hud/` | dir 0700 | state root |
| `state/<sid>.jsonl` | 0600 | one small event per hook, see below |
| `state/<sid>.summary.json` | 0600 | week totals, todos, pinned skills for the pane |
| `ledger.json` | 0600 | tokens per day and model, plus per-transcript byte offsets and paths |
| `last-input.json` | 0600 | the last raw status-line JSON (includes `cwd`, `transcript_path`, `session_id`, model, cost) |
| `git.json`, `skills-count.json`, `prev-statusline.json`, `report.md`, `hud.js` | 0600 | caches, saved statusLine, report, installed copy |
| `debug.jsonl` | 0600 | only with `SESSION_HUD_DEBUG=1`: raw payloads of `skill`, subagent and model events. Can contain prompts, file contents and tool inputs. Appends stop past about 200 KB |
| `~/.claude/session-hud.json`, `.bak` | 0600 for a new file; an existing file keeps its mode | config |
| settings file, `.hud-bak` | existing mode (new settings file 0644) | `install` and `uninstall` only |

Event lines hold: event type, timestamp, session-scoped ids, skill names (100 chars), todo text (80 chars, 100 items), tool names (60 chars), a short tool argument (28 chars), agent descriptions (200 chars), types and model ids (60 chars). Todo text and agent descriptions can themselves contain sensitive wording; treat the state directory as private.

## What is never recorded

- Bash commands: `toolArg` reads only `file_path`, `notebook_path`, `path`, `pattern`, `url` and `query`, never `command`. The status-line `tools` row therefore never shows one.
- Prompts, tool responses and file contents, except in `debug.jsonl` when you turn it on.
- URL userinfo, query string and fragment (removed from `url` arguments).
- Anything over the network.

File basenames and search patterns are recorded (first 28 characters). A pattern or query can contain whatever was searched for.

The pane's live activity list is built in the mod from `tool.call` events and can show a Bash command (first 60 characters) or a description. It is held by the mod's atoms and the plugin never writes it to disk; whether Claude Code itself persists plugin state is outside what this code shows.

## Hardening

| Measure | Where | Effect |
|---|---|---|
| `safeSid()` | every state path | session ids reduced to `[\w-]`, 100 chars, so `../../x` cannot leave the state directory. The pane applies the same character filter |
| `clean()` | all untrusted strings in the renderer; `cl()` in the pane | removes tabs and newlines, C0, DEL, C1 and bidi override characters, so no escape sequence or spoofed text reaches the terminal |
| `sgrOnly()` | last step of every render | strips every control character and any ESC that is not an SGR color sequence |
| `noProto()`, key checks | config and `config set` | drops `__proto__`, `constructor`, `prototype`; ledger writes also skip a `__proto__` model |
| theme validation | config | a color must be `#rrggbb` or digits and semicolons, a preset name is looked up in a fixed table; anything else is ignored, so a theme cannot inject escape sequences. The pane re-validates the hex values it reads from the summary file |
| permissions | all state | dir 0700, files 0600, temp files created with exclusive flag and renamed, so a planted symlink at the temp name is not followed |
| strict JSON | `install`, `uninstall`, `config` | a settings or config file that does not parse as a JSON object is never rewritten; the command exits 1 |
| symlinks | settings and ledger | a project-local settings symlink is refused. For `--user` a symlinked `settings.json` is resolved and its real target is replaced atomically, keeping its mode. The `.hud-bak` and `report.md` paths replace a symlink instead of writing through it. The transcript walk ignores symlinked files and directories |
| shell quoting | `install` | the statusLine command uses double quotes, or POSIX single quotes if the path has shell-special characters |
| git | `gitInfo` | runs only for `project`; `execFileSync` with an argument array, `--no-optional-locks`, `core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, stdin and stderr ignored, 800 ms timeout, 1 MB output cap, and only an absolute cwd |
| input bounds | hook, render, scan, walk | 1 MB stdin; state log trimmed at 2 MB; 32 MiB per file per scan pass; at most 5000 transcripts at depth 6; `CLAUDE.md` first 64 KB; todos 100 items |
| failure mode | hooks | errors are swallowed; a hook never blocks or prints |
| no network | whole plugin | no `http`, `net` or fetch code; `child_process` is used only for `git` and to re-run `hud.js scan` |

<a id="report"></a>

## `report`

`node src/hud.js report` writes and prints `report.md` with node version, platform, your config, the last status-line input and a render. It replaces:

- the status-line `cwd`, `workspace.current_dir`, `project_dir` and `added_dirs` with `<cwd>`;
- `$HOME` with `~` and any remaining `/Users/<name>` or `/home/<name>` with `/<user>`;
- UUID-shaped session ids with `<id>` (other id shapes are left as is);
- `transcript_path` with `<transcript>`;
- tokens: `sk-...`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `xox[abprs]-`, `AKIA...`, JWTs, and values after `Bearer` or `Basic`.

It drops `tool_input`, `tool_response` and `prompt` if present. It does not scrub the render itself, which holds todo text, file names, skill names, agent descriptions and branch names, nor your config. Read the file before sharing it.

## Deliberately not covered

- **`$HOME` and `~/.claude` are trusted.** An attacker who can write there can replace `hud.js`, the settings or the config, and 0600 does nothing against the same user or root.
- **Other processes as the same user** can read the state files; permissions only protect against other accounts.
- **Prompt content is not filtered** from what Claude Code sends to hooks; the hook avoids storing it but receives it.
- **Transcript contents** are parsed for usage only, and malformed lines are skipped; the format is undocumented.
- **Heuristics** (token masking in `report`, always-on skill detection, provider label) are best effort, not guarantees.
- **The pane's runtime** (Claude Code's mod host) is outside this repo.
- **Windows** is untested.
