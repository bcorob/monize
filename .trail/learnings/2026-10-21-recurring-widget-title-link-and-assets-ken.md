---
title: Recurring widget title link and Assets vs Liabilities donut view
author: Ken
date: 2026-10-21
branch: feat/recurring-link-assets-liabilities-view
touches:
  - frontend/src/components/dashboard/AssetsVsLiabilities.test.tsx
  - frontend/src/components/dashboard/AssetsVsLiabilities.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.test.tsx
  - frontend/src/components/dashboard/RecurringExpensesWidget.tsx
  - frontend/src/components/dashboard/widget-config.ts
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/en/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/dashboard.json
---

## Decided
- Top Recurring Expenses title links to /reports/recurring-expenses (the Recurring Expenses Tracker report) via `titleHref` on WidgetCard.
- Assets vs Liabilities moved off its hand-rolled card onto WidgetCard + the shared DonutCalloutChart, so it gets the same Labels/Legend view setting as the recurring and expenses widgets. New `AssetsLiabilitiesConfig` / `ASSETS_LIABILITIES_DEFAULT` in widget-config.ts; default is `legend`, the layout it always had.
- Net Worth now sits in the donut hole (DonutCenterTotal through `center`). It is compact (`formatCurrencyTight`) in the callout view and full in the legend view. A negative figure keeps the red text classes.
- Translated the new `assetsVsLiabilities.viewCallouts/viewLegend` keys by copying each locale's existing `recurringExpenses.viewCallouts/viewLegend` text.

## Tried and ruled out
- Matching legend rows with `/Assets/` in tests: it also matches the gear's "Configure Assets vs Liabilities" label. Anchor it as `/^Assets/`.

## Watch out
- en-GB and en-US dashboard.json are partial overlays with no assetsVsLiabilities section. Skip them when adding keys.
- In the callout view the centre shows `compactValue`. A test mock must define `formatCurrencyTight` or the figure won't match.
