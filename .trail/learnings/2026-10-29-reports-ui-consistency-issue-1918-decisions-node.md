---
title: "Reports UI consistency (issue 1918): decisions and rejected audit items"
author: Node
date: 2026-10-29
branch: claude/issue-1918
cost: { minutes: 42, tokens: 452708 }
touches:
  - "frontend/src/app/reports/custom/[id]/edit/page.tsx"
  - frontend/src/app/reports/custom/new/page.tsx
  - "frontend/src/app/reports/investment/[id]/edit/page.tsx"
  - frontend/src/app/reports/investment/new/page.tsx
  - frontend/src/app/reports/monte-carlo-simulation/compare/page.tsx
  - frontend/src/app/reports/page.test.tsx
  - frontend/src/app/reports/page.tsx
  - frontend/src/components/calendar/TransactionsCalendarView.test.tsx
  - frontend/src/components/reports/AccountBalancesReport.tsx
  - frontend/src/components/reports/BillPaymentHistoryReport.test.tsx
---

## Decided
- Report view switches with text labels became the segmented control (`SEGMENTED_GROUP_CLASS` + `segmentClass`, `role="group"`, `aria-pressed`, labelled by `reports.reportPage.viewLabel`); icon chart/table pairs became `ChartViewToggle` with `options={['bar','table']}` mapped to the report's own 'chart'/'table' state.
- Reports that returned early on `isLoading`/`error` now compute `dataUnavailable`, show skeleton summary cards, keep the toolbar mounted and render `ReportError`/skeleton in the content slot. Regression test: the mocked `date-range-selector` node is the same before and after a failed load.
- `ReportError` renders `Button` and reads "Try Again"; every test asserting the old "Try again" (reports, calendar, strategies) was updated.
- Month headings use `useChartDateFormat` ('MMMM yyyy'), full dates `useDateFormat().formatDate`; the report-locale guard's English-month baseline is now empty.
- Empty-state guard extended to `text-center py-8` but scoped to report directories, so other UI-consistency issues' files are not dragged in.

## Tried and ruled out
- D22 "Group By"/"Sort By": the screens doc says a phrasal particle is capitalised; kept.
- D33 on InvestmentReportViewer and AccountBalancesControls: single as-of DateInput, not a range. CustomReportViewer keeps its timeframe Select (saved-report override vocabulary).
- D29 on Custom/InvestmentReportViewer: their `isLoading` is only the initial definition load; reruns use `isExecuting` inside the tree.
- D34 on BudgetHealthScore, BudgetSeasonalPatterns, HealthScoreHistory, SavingsRate: the flagged `p-4 sm:p-6` cards hold tables, not charts.
- D15 on the new-report pages: a form page keeps its max-w column, same as the unflagged edit pages.

## Watch out
- `NetWorthByAccountTypeChart` is shared with the dashboard widget, which passes `fontSize={11}`; the legend keeps that size only when a caller sets it.
- A test mocking `@/lib/utils` without `importOriginal` breaks once a component uses `useDateFormat` (needs `formatDate`).
- trail check flags these Tailwind/class edits against unrelated learnings by word overlap.
