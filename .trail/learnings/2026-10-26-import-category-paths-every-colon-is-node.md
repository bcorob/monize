---
title: "Import category paths: every colon is a level; .qmtf is QIF"
author: Node
date: 2026-10-26
branch: claude/issue-1881
cost: { minutes: 20, tokens: 217692 }
touches:
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/fr/import.json
  - frontend/src/i18n/messages/hi/import.json
  - frontend/src/i18n/messages/id/import.json
  - frontend/src/i18n/messages/it/import.json
  - frontend/src/i18n/messages/ja/import.json
  - frontend/src/i18n/messages/ko/import.json
  - frontend/src/i18n/messages/nl/import.json
  - frontend/src/i18n/messages/pl/import.json
---

## Decided
- `splitCategoryPath` (backend/src/import/category-path.util.ts) is the one splitter for QIF/CSV category paths; every colon is a level. Multi-account QIF (`createCategoriesFromDefs` / `createCategoriesFromBlocks` via `findOrCreateCategoryPath`) and the mapping step (`createNewParentCategoryName`, now a colon path walked root first) both use it.
- Frontend mapping (`buildCategoryMappings`) sends either `parentCategoryId` (whole parent path exists) or `createNewParentCategoryName` as a full root path spelled with existing names; never both, because `CategoryMappingRow` treats the two as exclusive.
- `findMatchingCategory`'s fuzzy fallback requires the paths to agree on every shared level from the leaf up (min 2), so "Business > Mortgage > Interest" is not matched for "Housing:Mortgage:Interest".
- .qmtf (Quicken for Mac) is plain QIF: only the accept list, the format copy and bare-`\r` line splitting were needed. `messages.import-formats.test.ts` forces every accepted extension into four strings in every locale.
- .mny is untouched: Money has two levels.

## Tried and ruled out
- Leaf + immediate-parent matching for deep paths: matches the wrong branch.

## Watch out
- `parentCategoryOptions` used to list top-level only; a deep suggested parent would render unselected.
- On this machine TZ=America/Toronto: `loan-payment-frequency.guard.spec.ts` fails locally and passes with TZ=UTC (what CI uses).
- `trail check` flagged a `waitFor` count change against an unrelated Docker-digest learning; false positive.
