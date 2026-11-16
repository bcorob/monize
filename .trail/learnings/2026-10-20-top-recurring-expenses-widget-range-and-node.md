---
title: "Top Recurring Expenses widget: range and callout labels (issue 1787)"
author: Node
date: 2026-10-20
branch: claude/issue-1787
cost: { minutes: 17, tokens: 222472 }
touches:
  - frontend/src/components/dashboard/RecurringExpensesChart.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.test.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.tsx
  - frontend/src/components/dashboard/recurring-callout-layout.test.ts
  - frontend/src/components/dashboard/recurring-callout-layout.ts
  - frontend/src/components/dashboard/widget-config.ts
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/en/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
---

## Decided
- The recurring analysis (`TaxRecurringReportsService.getRecurringExpenses`) was hard-wired to 6 months. It now takes `range` (6m, 1y, 2y, 5y, all; unknown falls back to 6m, so the report is unchanged). `summary.monthCount` is the divisor of `monthlyEstimate`; for `all` it is the whole months since the first matching payment (min 1). Frequency thresholds were tuned for 6 months and now scale with monthCount (`classifyFrequency`).
- Callout layout is a pure module, `frontend/src/components/dashboard/recurring-callout-layout.ts`, mirroring Recharts' Pie angle maths (`sliceMidAngles`) so leader lines start on their slices. It returns null when boxes cannot fit; the chart then shows the legend. Chart area min-height 260px means only width can fail, so the fallback cannot oscillate.
- Default view is `callouts` (labels), default range `6m`.

## Watch out
- Recharts' tooltip paints under absolutely positioned overlays placed after the PieChart; give the Tooltip `wrapperStyle={{ zIndex: 10 }}`.
- The ResizeObserver stub in src/test/setup.ts never fires; a test that needs a measured size stubs ResizeObserver to call back from observe() (see RecurringExpensesWidget.test.tsx `observeAs`).
- The `$2::date IS NULL OR ...` pattern lets one query serve a bounded and an unbounded window; verified against real PostgreSQL via embedded-postgres.
