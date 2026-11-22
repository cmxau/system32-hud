# Contributing

system32-hud is a Claude Code plugin: a status line (`src/hud.js`) plus a side pane and working line (`hooks/register.tsx`). Small, focused PRs are welcome.

## Design rules

- The status line is one zero-dependency Node file, `src/hud.js`. No `package.json` dependencies, no build step.
- No network calls, no telemetry. Ever.
- Treat hook payloads, transcripts, repo and file names as untrusted: run strings through `clean()` before rendering, build state paths only with `safeSid()`, and never record Bash commands or raw payloads (`debug.jsonl` is opt-in via `SYSTEM32_HUD_DEBUG=1`).
- State lives only under `~/.claude/system32-hud/` (plus `~/.claude/system32-hud.json` and its `.bak` for config, and the settings file `install` edits with a `.hud-bak` beside it). Write state with `wr()`/`wrText()` (atomic, 0600), user files with `wrUser()`. `install` copies `hud.js` into the state dir, so a changed `src/hud.js` only reaches the status line after `install` is re-run (or use `install --link` while developing).
- `replay`, `report` and `config preview` must stay read-only: anything that writes or spawns in `render()` has to check `DRY`.
- Hooks run async and must never fail loudly: swallow errors, never block Claude Code.
- Estimates are marked with `~` (`—` for unavailable), and every caveat goes in the README's "Where each number comes from" table.

## Dev loop

```
claude --plugin-dir .          # load the plugin from this checkout
node src/hud.js install --link # point your settings at this checkout
```

Render without Claude Code by piping status-line JSON in. `tests/sample.json` is a sample payload; `%FIVE%` and `%SEVEN%` are `resets_at` epoch seconds you fill in:

```
export HOME=$(mktemp -d)   # keep your real ~/.claude untouched
now=$(date +%s)
sed "s/%FIVE%/$((now+6000))/; s/%SEVEN%/$((now+200000))/" tests/sample.json | COLUMNS=100 node src/hud.js
```

Other handy commands: `node src/hud.js replay` (re-render the last input), `config preview k=v` (try a setting without saving).

## Checks

```
node --test tests/
claude plugin validate .
tsc -p .claude-plugin/types/tsconfig.json
```

tsc is not a project dependency: install `typescript` locally or run it with `npx -p typescript tsc ...`. It checks `hooks/`, `types/` and `tests/`.

## Add a status-line section

All in `src/hud.js`:

1. Add the name to `DEFAULTS.sections` (order is row order and compact priority), unless it should be opt-in like `project` and `uptime`.
2. In `render()`, fill `R.<name>` (the full row) and `C.<name>` (the compact segment; a section with no `C` entry never shows in compact or docked mode).
3. Add it to the README tables (what you see, config `sections`, where the number comes from, with caveats).
4. Add a test in `tests/test.js`.

## Add a theme

Add an entry to `THEMES` in `src/hud.js`: the six keys `dim`, `fg`, `acc`, `ok`, `warn`, `bad` as `#rrggbb` (and `bg` only if the theme should paint the row). Add it to the preset table in `docs/configuration.md`. The tests check every preset is complete.

## Add a pane block

- Add the block in the `Pane` render handler in `hooks/register.tsx`, in the same flat style.
- Data the pane can't read itself (no transcript or hook access) goes through the summary file: `render()` in `src/hud.js` writes `~/.claude/system32-hud/state/<session>.summary.json`, and the `Summary` type in `register.tsx` reads it.
- New plugin atoms need an entry in `PluginState` in `types/index.d.ts`.
- Update the README's pane table.

## Pricing

Prices are the `PRICES` table at the top of `src/hud.js` ($/MTok: input, output, cache read). Cache-write rates (1.25x for 5m, 2x for 1h) are assumed, as are cache-read rates for some older models. When you change a price, cite the source in the PR and keep the README caveat accurate.

## PR checklist

- [ ] `node --test tests/` passes
- [ ] `claude plugin validate .` passes
- [ ] README updated for any visible or config change
- [ ] no new dependencies
- [ ] no network calls

## Bugs

Run `node src/hud.js report`. It writes a bug report locally, replacing your home path, user name and session ids, and sends nothing. Read it before attaching it to an issue.
