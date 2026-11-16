---
title: "Donut centre figure must fit the callout view's hole (issue 1789 review)"
author: Node
date: 2026-10-21
branch: claude/issue-1789
cost: { minutes: 2, tokens: 22967 }
touches:
  - frontend/src/components/dashboard/DonutCalloutChart.tsx
  - frontend/src/components/dashboard/ExpensesPieChart.test.tsx
  - frontend/src/components/dashboard/ExpensesPieChart.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.test.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.tsx
---

## Decided
- Supersedes the `minRadius: 80` in the earlier 1789 learning: a DonutCalloutChart with a `center` asks the layout for `minRadius: 96` (hole about 105px, figure capped at 90% of it).
- The centre takes `compactValue` (formatCurrencyTight, "$123.5K") drawn only in the callout view; the legend view keeps the full figure.

## Watch out
- `formatCurrencyCompact` only drops cents, it does not abbreviate: "$123,456" plus a PartialTotal marker is well over 79px at text-lg. Use formatCurrencyTight for a figure in a small fixed space.
