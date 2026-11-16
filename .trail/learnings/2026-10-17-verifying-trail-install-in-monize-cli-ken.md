---
title: "Verifying trail install in monize: CLI slow, no MCP by design"
author: Ken
date: 2026-10-17
branch: main
---

## Decided
- Trail 0.23.0 (@trailhq/trail-code, global npm in ~/.npm-global) is installed and the repo is wired: .trail/ (hook.cjs, statusline.cjs, built code map in .trail/cache), with the SessionStart hook, statusline and Bash(trail:*) permission in .claude/settings.local.json.
- Wiring is machine-local on purpose or by accident: settings live in the gitignored settings.local.json and .trail/ is in .git/info/exclude, unlike the README's "commit this folder" advice.

## Tried and ruled out
- `trail status` and `trail skeleton <file>` are not hung, just slow: well over a minute CPU-bound at 100%, ~2 GB RSS, no open files or stdin wait, then they complete. A 15s timeout is too short and reads as a hang. Suspect the 195 MB .trail/cache/.cache/extract.*.json being loaded/processed on every command. `trail note` does not load it and returns immediately.
- Running .trail/hook.cjs session-start by hand printed nothing.

## Watch out
- `trail status` takes ~2.5 minutes here (137s measured) but completes; `trail ask` answered in 3s and pointed at the right line (withScopedDb, scoped-db.ts:155). Give status a generous timeout or run it in the background rather than concluding it hangs.
- Trail 0.23 has no MCP server by design (dist/claude/init.js: "No MCP server: the hooks and the `trail` command do what it did"); init removes any old .mcp.json entry. wiring-stamp.json saying mcp: true is misleading. Do not go looking for trail_* MCP tools; use the CLI.
- What 0.23 does install: global hooks in ~/.claude/settings.json via ~/.claude/helpers/graft-hooks.cjs, a skill at ~/.claude/skills/trail/SKILL.md, and a SessionStart entry in the shared .claude/settings.json. The skill goes in the home directory, not the repo, so there is no .claude/skills/ in monize. A first init here left the skill missing and the SessionStart entry in settings.local.json; re-running `trail init` fixed both.
- INDEX.md and the CLI default --dir point at <repo>/graft/, which does not exist; the map was built into .trail/cache/. Possible contributor to the slowness, unconfirmed.
- `trail init` always writes the SessionStart hook into the shared .claude/settings.json. Here Trail is kept local (.trail/ is in .git/info/exclude), so after any init move the hook back to settings.local.json. Committing it alone breaks every contributor's session start: it calls a .trail/hook.cjs that isn't in their checkout.
