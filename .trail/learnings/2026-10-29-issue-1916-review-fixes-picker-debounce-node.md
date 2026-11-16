---
title: "Issue 1916 review fixes: picker debounce after clearing, institution status counts"
author: Node
date: 2026-10-29
branch: claude/issue-1916
cost: { minutes: 13, tokens: 56018 }
touches:
  - frontend/src/app/institutions/page.test.tsx
  - frontend/src/app/institutions/page.tsx
  - frontend/src/i18n/messages/de/institutions.json
  - frontend/src/i18n/messages/en/institutions.json
  - frontend/src/i18n/messages/es/institutions.json
  - frontend/src/i18n/messages/fr/institutions.json
  - frontend/src/i18n/messages/hi/institutions.json
  - frontend/src/i18n/messages/id/institutions.json
  - frontend/src/i18n/messages/it/institutions.json
  - frontend/src/i18n/messages/ja/institutions.json
---

## Decided
- ReceiptTransactionPicker applies a search only when the debounced value equals the box's current text (render-time adjustment), and an empty box at once; a value that rested before the box was emptied is never asked for again.
- The institutions status segments count All, Active and Closed from the one accounts list (All = Active + Closed); a failed accounts read draws plain labels (list.statusFilter.*), the counted ones are list.statusFilter.counted.*.

## Tried and ruled out
- Taking All from the server's per-institution accountCount: it can disagree with the browser's accounts list the other two segments split.

## Watch out
- The frontend suites run on Vitest (`npx vitest run <file>`), not Jest; the backend is the Jest layer.
- A debounced search that short-circuits the empty case still holds the old rested value for the delay; compare it with the current text before using it.
