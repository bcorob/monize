---
title: Recurring expenses estimate and callout lines after review (issue 1787)
author: Node
date: 2026-10-20
branch: claude/issue-1787
cost: { minutes: 6, tokens: 58803 }
touches:
  - frontend/src/components/dashboard/RecurringExpensesChart.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.test.tsx
  - frontend/src/components/dashboard/recurring-callout-layout.test.ts
  - frontend/src/components/dashboard/recurring-callout-layout.ts
  - backend/src/built-in-reports/dto/recurring-expenses.dto.ts
  - backend/src/built-in-reports/tax-recurring-reports.service.spec.ts
  - backend/src/built-in-reports/tax-recurring-reports.service.ts
  - backend/test/integration/report-investment-cash.integration.spec.ts
---

## Decided
- Supersedes part of the earlier 1787 learning: `summary.monthCount` is now the preset capped at the user's spending history (months, rounded, from the first reportable spending row on or before today), and `all` spans that history, not the first matching payment. The history start comes from a scalar subquery in the same SQL, built by `recurringSpendingRows(t, a)` so it counts the same rows as the analysis.
- Leader lines whose straight path would cross the donut are routed around it (`leaderLine` in recurring-callout-layout.ts): out past the rim at the elbow's x, across above/below, down the gap beside the column. The layout tests assert every segment stays outside the donut.

## Watch out
- A Recharts chart given explicit width/height and left in the normal flow pins its container at that size; a measured area's content must all be absolutely positioned or the area can grow but never shrink.
- Mocks of `scopedManager.query` that lack `history_start` fall back to the preset months for bounded ranges, so older specs keep their /6 expectations.
