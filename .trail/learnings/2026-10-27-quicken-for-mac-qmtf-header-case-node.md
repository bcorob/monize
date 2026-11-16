---
title: "Quicken for Mac .qmtf: header case, account catalog, untyped accounts"
author: Node
date: 2026-10-27
branch: claude/issue-1897
cost: { minutes: 26, tokens: 213200 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
- QIF section headers match in any case (`TYPE_HEADER`, `ACCOUNT_HEADER`, `AUTOSWITCH_DIRECTIVE` in backend/src/import/qif-parser.ts); Quicken for Mac writes `!TYPE:Bank`. The frontend's multi-account detector in useImportWizard.ts is a third copy of the check and must match the same way.
- An `!Account` section can hold a whole catalog of definitions separated by `^` (AutoSwitch). parseQifFull records every definition by name, merges repeats (blank fields never erase known ones), fills a later section's blank fields from it, and appends an empty block for a catalog account that has no transaction section.
- `QifAccountBlock.accountType` is `null` when nothing names a type QIF defines (`resolveQifAccountType`). The review step makes the user pick a type; the import applies `accountTypes` choices only to untyped blocks and refuses before its transaction if a named block is still untyped. No more silent CHEQUING and no more uppercased unknown types (e.g. "GIZMO") reaching the account enum.

## Tried and ruled out
- A warning only for blank types: it still creates the account under a guessed type.

## Watch out
- Backend `tsc` needs NODE_OPTIONS=--max-old-space-size=4096 here, otherwise it aborts on heap.
- `trail check` flags keyword false positives (category map, bills) on these files.
