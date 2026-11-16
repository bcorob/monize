---
title: ZAP baseline alert triage (rules.tsv + pinning guard)
author: Node
date: 2026-10-23
branch: claude/issue-1842
cost: { minutes: 5, tokens: 53419 }
touches:
  - ".github/zap/rules.tsv"
  - frontend/src/test/public-scripts.guard.test.ts
  - frontend/src/store/persisted-storage.guard.test.ts
  - frontend/public/sw.js
---

## Decided
- Nightly ZAP issues ("ZAP Baseline Report") are triaged in .github/zap/rules.tsv: RULE_ID<TAB>IGNORE<TAB>(reason), with a comment block above. The third column is a free-text reason; baseline cannot scope an ignore to one URL.
- Each IGNORE whose justification is a claim about the source gets a vitest guard that pins it (120000 -> frontend/src/store/persisted-storage.guard.test.ts; 10027 -> frontend/src/test/public-scripts.guard.test.ts).
- 10027 (Suspicious Comments) fires on frontend/public/sw.js only: hand-written, served unminified, comments contain "user"/"from"/"where". The guard keeps sw.js the only .js/.html under public/ and bans TODO/FIXME/XXX/HACK/BUG in it.

## Tried and ruled out
- Stripping comments from sw.js at build time: public/ is served verbatim, and four test suites (sw-offline, sw-push, sw-share-target, notification-badge) read public/sw.js by path.

## Watch out
- The worktree may have no frontend/node_modules; run `npm ci` in frontend/ before vitest/eslint.
- Adding a file to public/ that is .js/.html fails public-scripts.guard.test.ts on purpose: add it to VERBATIM_SCRIPTS with a reason.
