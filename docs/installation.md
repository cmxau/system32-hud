# Installation

```
claude plugin marketplace add cmxau/system32-hud
claude plugin install session-hud@<marketplace>
```

Or in one step on Claude Code 2.1.275+: `/plugin install session-hud --marketplace cmxau/system32-hud`.

Then, inside Claude Code, say "set up session-hud" (runs the `setup` skill), or run:

```
node <plugin>/src/hud.js install [--user]
```

Plugins can't ship a `statusLine`, so `install` edits `.claude/settings.local.json` in the current directory (or `~/.claude/settings.json` with `--user`). It:

- copies `hud.js` to `~/.claude/session-hud/hud.js` and points the statusLine at that copy, so the status line runs a **snapshot** until you re-run `install` after a plugin update (hooks always run from the plugin);
- writes a `.hud-bak` backup of the settings file beside it;
- saves any previous statusLine to `~/.claude/session-hud/prev-statusline.json` so `uninstall` restores it;
- writes the settings atomically, keeping the file's mode (a new file is 0644). With `--user` a symlinked `settings.json` is written through to its real target.

`install`, `uninstall` and `config set` exit 1 and change nothing if the existing settings or config file is not valid JSON (or not a JSON object). `install` and `uninstall` also refuse a project-local settings file that is a symlink. See [troubleshooting](troubleshooting.md).

Local testing: `claude --plugin-dir .` and `node src/hud.js install --link` (points settings at this checkout, no copy).

Needs Node. Tested on macOS and Linux; Windows untested. `plugin.json` declares `claude-code >=2.1.300`.
