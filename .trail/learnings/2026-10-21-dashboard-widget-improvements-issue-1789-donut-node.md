---
title: "Dashboard widget improvements (issue 1789): donut callouts, net worth by type, Sankey labels"
author: Node
date: 2026-10-21
branch: claude/issue-1789
cost: { minutes: 27, tokens: 340484 }
touches:
  - frontend/src/components/dashboard/DonutCalloutChart.tsx
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/dashboard.json
  - frontend/src/i18n/messages/id/dashboard.json
  - frontend/src/i18n/messages/it/dashboard.json
  - frontend/src/i18n/messages/ja/dashboard.json
  - frontend/src/i18n/messages/ko/dashboard.json
  - frontend/src/i18n/messages/nl/dashboard.json
---

## Decided
- The Top Recurring Expenses donut became a shared `DonutCalloutChart` (components/dashboard/DonutCalloutChart.tsx); the layout module is now `donut-callout-layout.ts`. Expenses by Category uses it too: `view` (`callouts` | `legend`, default `legend`), top 10 categories + Other in the callout view, 11 + Other in the legend. A `center` figure (monthly estimate, total) is bounded by the measured hole; a chart with a centre asks the layout for `minRadius: 80` so the hole fits the figure.
- Net worth by account type comes from the server: GET /net-worth/monthly carries `byAccountType` (signed contribution, liabilities as -abs like the liabilities figure). `getLlmHistory` strips it so the AI/MCP shape is unchanged. The report's bar view and the widget's bar view share `components/reports/NetWorthByAccountTypeChart.tsx` (ComposedChart, stackOffset="sign", net worth as a Line, value labels carried by an invisible Line at `netWorthStackTop`).
- Sankey: the hub has no drawn label; every node label is cut to `labelMargin - 8` px by `fitSankeyLabel` (components/reports/sankey-label.ts; OffscreenCanvas measure in the browser, a 0.62em-per-char estimate in jsdom).

## Watch out
- src/test/number-locale.guard.test.ts flags a template type like `${number}%` as a composed percentage; type a Recharts radius as `number | string`.
- Frontend locales en-GB / en-US are override locales holding only a few keys; skip them when adding a key to every locale.
- AccountBalancesReport.test.tsx fails near local midnight under America/Toronto; run frontend specs with TZ=UTC too.
- Recharts Pie onClick is (data, index); read the slice by index rather than off the sector object.
