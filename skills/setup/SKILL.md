---
name: setup
description: Install or remove the system32-hud status line. Use when the user says "set up hud", "install system32-hud", or "remove hud". Plugins cannot ship a statusLine, so this edits settings.
disable-model-invocation: true
---

Run one of these with Bash, then tell the user to restart Claude Code (or send a message) to see the HUD:

- Install for this project only: `node "${CLAUDE_PLUGIN_ROOT}/src/hud.js" install`
- Install for all projects: `node "${CLAUDE_PLUGIN_ROOT}/src/hud.js" install --user`
- Remove: `node "${CLAUDE_PLUGIN_ROOT}/src/hud.js" uninstall [--user]`

Install backs up the settings file to `*.hud-bak` and saves any existing statusLine so uninstall restores it.
Config (optional): `~/.claude/system32-hud.json` — see README.

Tweaking: preview first, show the user the output, save only after they approve. `node "${CLAUDE_PLUGIN_ROOT}/src/hud.js" config preview k=v ...`, then `config set k=v ...`; `config undo` reverts the last change; `replay` re-renders the last real input; `report` writes a scrubbed bug report the user must read before sharing.
