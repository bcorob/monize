---
title: "Mobile full-width lone controls (#1933)"
author: Node
date: 2026-10-29
branch: claude/issue-1933
cost: { minutes: 7, tokens: 80130 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - docs/frontend/ui-conventions.md
  - frontend/CLAUDE.md
  - frontend/src/app/categories/page.test.tsx
  - frontend/src/app/categories/page.tsx
  - frontend/src/app/currencies/page.test.tsx
  - frontend/src/app/currencies/page.tsx
  - frontend/src/app/payees/page.test.tsx
  - frontend/src/app/payees/page.tsx
  - frontend/src/app/securities/page.test.tsx
---

## Decided
- A list toolbar's segmented filter uses SEGMENTED_TOOLBAR_GROUP_CLASS + toolbarSegmentClass
  (frontend/src/components/ui/segmented-control.ts): `${SEGMENTED_GROUP_CLASS} w-full sm:w-auto`
  on the pill and `grow sm:grow-0` on each segment. The plain SEGMENTED_GROUP_CLASS was left
  alone because it is also used for switches that share a row (Investments, reports, dialogs).
- Applied to Payees, Categories, Securities, Currencies, Warranties and Insights. The Payroll
  Deductions disclosure buttons get className="w-full sm:w-auto" (Button merges via cn).
- Institutions has no filter any more (removed in #1927); its search was already w-full.

## Tried and ruled out
- `flex-1` on segments: equal widths wrap long labels ("No Default Category (12)");
  `grow` keeps content width and only shares the extra space.
- AccountList's status filter: it sits in a nested non-full-width `flex items-center` wrapper,
  so w-full would not reach the line without restructuring that filter bar. Left as is.

## Watch out
- inline-flex + w-full works only because the pill is a flex item of the toolbar's flex-wrap
  row (blockified). Outside a flex row, the toolbar class would need `flex` instead.
