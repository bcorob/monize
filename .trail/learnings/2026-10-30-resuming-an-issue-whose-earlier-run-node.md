---
title: Resuming an issue whose earlier run already pushed the branch
author: Node
date: 2026-10-30
branch: claude/issue-1939
cost: { minutes: 20, tokens: 60962 }
touches:
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/accounts.service.ts
  - frontend/src/i18n/messages/de/accounts.json
  - frontend/src/i18n/messages/es/accounts.json
  - frontend/src/i18n/messages/fr/accounts.json
  - frontend/src/i18n/messages/hi/accounts.json
  - frontend/src/i18n/messages/id/accounts.json
  - frontend/src/i18n/messages/it/accounts.json
  - frontend/src/i18n/messages/ja/accounts.json
  - frontend/src/i18n/messages/ko/accounts.json
---

## Decided
- When the worktree branch starts clean at origin/main but origin/claude/issue-N already carries an earlier run's unmerged commits, rebuild on current main by cherry-picking that branch's feature commits (git log origin/main..origin/claude/issue-N) rather than re-implementing. For #1939 the four feature commits applied cleanly.
- Drop commits from the old branch that main has since fixed independently (here two calendar-test fixes superseded by #1940), and say in the PR that the remote branch is replaced, not fast-forwarded.

## Tried and ruled out
- `git diff main`: the local `main` ref in these worktrees is stale (far behind origin/main) and produces a huge unrelated diff. Diff against origin/main or HEAD~N.

## Watch out
- A fresh worktree has no node_modules in backend/ or frontend/; run npm ci in each first.
- Backend `npx tsc --noEmit` and `npm run typecheck` abort out of heap at the default size; NODE_OPTIONS=--max-old-space-size=4096 is enough.
- frontend and backend `npm run test:changed` take no arguments (passing --maxWorkers fails fast). The frontend run took about 23 minutes here.
- trail check lists lexical matches against unrelated learnings as "conflicts"; read each before acting.
