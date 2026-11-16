---
title: Multi-account QIF categoryMap holds full paths only
author: Node
date: 2026-10-26
branch: claude/issue-1881
cost: { minutes: 3, tokens: 27485 }
touches:
  - backend/src/import/import.service.spec.ts
  - backend/src/import/import.service.ts
---

## Decided
- In `ImportService` (multi-account QIF), `categoryMap` is keyed only by the full category string a transaction or split names; `findOrCreateCategoryDef` no longer maps bare level names. The defs and blocks steps share one `processedCategories` cache keyed `name|parentId`.

## Tried and ruled out
- Seeding the blocks step's cache with `<categoryMap key>|null`: once levels were mapped by bare name it put transaction-only paths under the wrong branch.

## Watch out
- The parser records L and S categories with the same truncated string the processor looks up, which is what makes full-path-only mapping safe; keep those in step.
- Frontend tests run with vitest (`npx vitest run <files>`), not jest.
