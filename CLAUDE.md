@AGENTS.md

## Claude Code specifics

The rules are in `AGENTS.md`, imported above. What follows applies to Claude Code only.

- **Navigate with LSP** (`workspaceSymbol`, `findReferences`, `goToDefinition`, `hover`) before Grep or Read; check LSP diagnostics after every edit and fix them before moving on.
- **Run the safe local actions yourself**: `.claude/settings.json` pre-approves lint, type-check, unit tests, the repo-level check scripts and read-only git. Ask before anything `AGENTS.md` lists under "Ask first".
- **A subagent pays for itself only on a wide read-only sweep or an isolated parallel branch** (the "grep every consumer" fan-out across both layers is the case). A single-file change, a focused test run or a question you can answer from one file is cheaper in-context. Never spawn one to re-run a suite you have already run.
- **Verify, do not assert.** Before reporting done, run the layer's checks from `AGENTS.md` once and quote the result (`test:changed` for tests; CI owns the coverage gate); "should pass" is not a result. Do not re-run the same suite hoping for a different outcome; find the cause.
- **Scope.** Change what was asked and the tests that prove it. A refactor, a new abstraction, a new dependency or a change under `.github/`, `helm/` or `database/migrations/` beyond the task is a separate proposal, stated to the user rather than done.
- **Output.** Report the diff and what you verified; no transcript, no restating the instructions, no emojis.
