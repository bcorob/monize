---
title: prettier --write on a backend source directory also re-aligns its README markdown tables
author: Ken
date: 2026-10-28
branch: fix/mny-money99-user-report
id: l-128f6634
scope: repo
status: active
src: agent
touches:
  - backend/src/import/mny/README.md
  - backend/src/import/mny/__fixtures__/README.md
---

## Watch out
- `npx prettier --write src/import/mny` (backend/) formats the `.md` files in that directory too, because prettier picks up every supported extension under a directory argument: it re-padded every table in `backend/src/import/mny/README.md` and `backend/src/import/mny/__fixtures__/README.md`, about 50 lines of churn unrelated to the change. Pass the `.ts` paths instead (or let the pre-commit hook format the staged files), then check `git diff --stat` for READMEs you did not mean to touch.

## Tried and ruled out
- Keeping the re-aligned tables, because they bury the real README edit in a feature diff; they belong in a formatting-only commit if anyone wants them.
