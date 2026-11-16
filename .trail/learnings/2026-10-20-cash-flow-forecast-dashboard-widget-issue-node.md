---
title: Cash Flow Forecast dashboard widget (issue 1785)
author: Node
date: 2026-10-20
branch: claude/issue-1785
cost: { minutes: 19, tokens: 259211 }
touches:
  - frontend/src/components/dashboard/CashFlowForecastWidget.test.tsx
  - frontend/src/components/bills/CashFlowForecastPlot.tsx
  - frontend/src/i18n/messages/de/bills.json
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/es/bills.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/bills.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/bills.json
  - frontend/src/i18n/messages/hi/dashboard.json
---

## Decided
- The forecast has no endpoint; it is projected in the browser by lib/forecast.ts. The Bills chart and the dashboard widget share one computation (`components/bills/useCashFlowForecast.ts`) and one drawing (`components/bills/CashFlowForecastPlot.tsx`), the same way CashFlowSankeyWidget reuses the report's CashFlowSankeyDiagram.
- Posted future-dated rows load through `lib/future-transactions.ts` (`loadFutureTransactions`). `currentBalance` excludes them, so a forecast without them is wrong rather than partial: when that load fails the widget shows a message, not a chart.
- Widget settings (period, accountIds) live in dashboardWidgetConfig. The Bills chart keeps its own localStorage keys, so the two surfaces are configured separately.
- The hidden-widget chips in CustomizeDashboardModal follow DASHBOARD_WIDGETS order, so "place beside widget X in Hidden Widgets" means registering the new widget right after X with defaultEnabled false. DEFAULT_DASHBOARD_WIDGET_IDS is unaffected.
- The widget loads its future rows from `useReportData` keyed on the dashboard's `isLoading`, so a dashboard reload (AI action, undo) refetches them too.

## Watch out
- Moving JSX that carries `bg-white dark:bg-gray-800 ... rounded-lg shadow` into a NEW file trips the inline-card guard in src/test/ui-conventions.test.ts, because the baseline is per file. Use ChartTooltipPanel (components/reports/ChartTooltip.tsx) for a chart tooltip.
- `@/test/recharts-mock` had no ComposedChart until this change; a multi-account forecast needs it.
- `useReportData` returns data=null with isLoading=false for one render, between a deps change and the fetch effect starting. Treat "null and no error" as still loading, or a failure message flashes.
- `npm run test:changed` runs vitest with default workers; on the 10Gi worker, run a copy of scripts/test-changed.mjs with --maxWorkers=2 (about 29 minutes for 779 files).
