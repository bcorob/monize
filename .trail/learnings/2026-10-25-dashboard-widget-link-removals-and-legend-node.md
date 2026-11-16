---
title: dashboard widget link removals and legend values
author: Node
date: 2026-10-25
branch: claude/issue-1853
cost: { minutes: 13, tokens: 153561 }
touches:
  - frontend/src/components/dashboard/ExpensesPieChart.test.tsx
  - frontend/src/components/dashboard/ExpensesPieChart.tsx
  - frontend/src/components/dashboard/FavouriteSecurities.test.tsx
  - frontend/src/components/dashboard/FavouriteSecurities.tsx
  - frontend/src/components/dashboard/InsightsWidget.test.tsx
  - frontend/src/components/dashboard/InsightsWidget.tsx
  - frontend/src/components/dashboard/UpcomingBills.test.tsx
  - frontend/src/components/dashboard/UpcomingBills.tsx
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/en/dashboard.json
---

## Decided
Issue #1853: removed the bottom "View all bills & deposits" button from UpcomingBills.tsx, "Manage securities" from FavouriteSecurities.tsx, and "View all insights" from InsightsWidget.tsx (the widget heading already links to the full page via WidgetHeading's href, so these were a redundant second link). Added per-category totals to the Expenses by Category widget's legend by removing the `legendValues={false}` override passed to DonutCalloutChart in ExpensesPieChart.tsx (the prop defaults to true and already renders a `trailing` value in ChartLegend; the override was only there to preserve the pre-refactor legend's no-value look).

## Tried and ruled out
Did not touch InsightsWidget's empty-state "Go to Insights" button — the issue only named "View all insights" specifically, and the empty-state CTA is a different control serving a different purpose (no content to view yet).
Did not touch FavouriteSecurities' empty-state link ("Visit the Securities page...") for the same reason.

## Watch out
Removing `legendValues={false}` changes each legend row's accessible name: a ChartLegend row's button name concatenates the category name and the trailing value text with NO whitespace between them (e.g. "Cat 0$140.00", not "Cat 0 $140.00"), because the two spans are adjacent DOM nodes with no text node between. Tests asserting `getByRole('button', { name: 'Cat 0' })` must switch to a regex partial match (`name: /Cat 0/`) plus a separate `toHaveTextContent('$140.00')` check — the exact-string form breaks. This is the existing convention other legend-using widget tests (RecurringExpensesWidget.test.tsx) already follow.
