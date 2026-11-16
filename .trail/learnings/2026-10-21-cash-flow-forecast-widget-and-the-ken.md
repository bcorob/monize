---
title: Cash Flow Forecast widget and the overdue occurrence carry
author: Ken
date: 2026-10-21
branch: fix/cashflow-widget-overdue
cost: { minutes: 1, tokens: 8594 }
---

## Decided
- The dashboard CashFlowForecastWidget needs no code change for PR #1795 (overdue scheduled occurrences carried onto today). It shares useCashFlowForecast, CashFlowForecastPlot and scheduledTransactionsApi.getAll() with the Bills & Deposits chart, so carryOverdue, the overdue-excluded Starting figure and the tooltip count all reach it.
- Added widget tests that run the real builders: an overdue ONCE bill lands on today tagged overdueOriginalDate, in both the single-line and the per-account (buildMultiAccountForecast) views, and Starting stays the current balance.

## Tried and ruled out
- A partial vi.mock('@/lib/forecast') missing countOverdueOccurrences, which would break the plot import: none exist. The widget test spreads importOriginal, and CashFlowForecastChart.test was updated in the PR.

## Watch out
- recharts-mock stubs Tooltip as a no-op, so widget tests cannot assert the tooltip text. That text is covered only in CashFlowForecastChart.test.tsx.
- Any new change to the forecast in lib/forecast.ts or the shared plot affects both surfaces. Test the widget through the real builders, not mocked ones.
