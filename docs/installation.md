# Installation

```
claude plugin marketplace add cmxau/system32-hud
claude plugin install system32-hud@system32-hud
```

The marketplace and the plugin are both named `system32-hud`, so the install target is `system32-hud@system32-hud`. Or in one step inside Claude Code 2.1.275+: `/plugin install system32-hud --marketplace cmxau/system32-hud`.

Then, inside Claude Code, say "set up system32-hud" (runs the `setup` skill), or run:

```
node <plugin>/src/hud.js install [--user]
```

Plugins can't ship a `statusLine`, so `install` edits `.claude/settings.local.json` in the current directory (or `~/.claude/settings.json` with `--user`). It:

- copies `hud.js` to `~/.claude/system32-hud/hud.js` and points the statusLine at that copy, so the status line runs a **snapshot** until you re-run `install` after a plugin update (hooks always run from the plugin);
- writes a `.hud-bak` backup of the settings file beside it;
- saves any previous statusLine to `~/.claude/system32-hud/prev-statusline.json` so `uninstall` restores it;
- writes the settings atomically, keeping the file's mode (a new file is 0644). With `--user` a symlinked `settings.json` is written through to its real target.

`install`, `uninstall` and `config set` exit 1 and change nothing if the existing settings or config file is not valid JSON (or not a JSON object). `install` and `uninstall` also refuse a project-local settings file that is a symlink. See [troubleshooting](troubleshooting.md).

## Pick a theme

The default theme is `default`. Eleven presets ship; list them, preview one without saving, then keep it:

```
node <plugin>/src/hud.js config themes
node <plugin>/src/hud.js config preview theme=nord
node <plugin>/src/hud.js config set theme=nord
```

The status line and the side pane share the theme (the pane follows within 5 seconds). Tweak one color with `config set theme.acc=#ff00ff`; all options are in [configuration](configuration.md#themes).

Local testing: `claude --plugin-dir .` and `node src/hud.js install --link` (points settings at this checkout, no copy).

Needs Node. Tested on macOS and Linux; Windows untested. `plugin.json` declares `claude-code >=2.1.300`.
