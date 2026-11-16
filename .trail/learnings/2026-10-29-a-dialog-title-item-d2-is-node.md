---
title: "A dialog title item (D2) is fixed through Modal title, not a restyled h2"
author: Node
date: 2026-10-29
branch: claude/issue-1918
cost: { minutes: 3, tokens: 24222 }
touches:
  - frontend/src/components/reports/MonteCarloSaveAsDialog.test.tsx
  - frontend/src/components/reports/MonteCarloSaveAsDialog.tsx
  - frontend/src/test/ui-conventions.test.ts
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
---

## Decided
- docs/frontend/screens-and-dialogs.md treats a dialog that draws its own `h2` instead of passing `Modal`'s `title` as a defect whatever its styling, so an audit item "title is not text-2xl font-bold" (D2) is fixed with `title=` (plus `padding="md"`), not by restyling an in-body heading. MonteCarloSaveAsDialog moved to `title`; its explanation became an `InfoTooltip` beside the Name label, not inside the title (the title is the dialog's accessible name).
- Fixing one removes its line from the "a dialog is titled through Modal" baseline in src/test/ui-conventions.test.ts.

## Tried and ruled out
- An in-body `h2 text-2xl font-bold` (the issue 1919 settings approach): looks right, but leaves the dialog unnamed; the review rejected it here.

## Watch out
- `Modal` still draws `title` in a bordered strip with an X (known debt in the screens doc); the rule is to pass `title` anyway.
- A confirmation is the exempt kind: a delete dialog's D2 is fixed by `ConfirmDialog`, not `title`.
