# Portfolio charts: one value change, one window

The plan for INV-PORTCHART-001 and the invested value change. The invariants
are `docs/specs/portfolio-period-result.md` sections 10.2 to 10.5 and 10.9, and
`docs/time-series-contract.md` section 2.7. The task list is
`docs/future-plans/portfolio-chart-boundaries-tasks.md`.

## The problem

On the Portfolio Value Over Time report and the Investments page chart, the
"Value Change" figure did not equal the plotted line's last point less its
first. The windows the figures were measured over were right: the client names
a preset and the server resolves it from `portfolio-period-presets.util.ts`,
which `portfolio-range-window.ts` mirrors day for day. Two other things were
wrong:

1. **The measure.** The charts plot `securitiesValue` (no cash), but "Value
   Change" was the account-level `valueChange`, cash and deposits included, and
   "Net Deposits and Withdrawals" beside it was account-level too, while the
   Investment Result and Return are the invested part's. The four figures
   neither matched the line nor added up.
2. **The window, on long ranges.** The report's 6M, 2Y (its default), 5Y, All
   and a custom window over a year, the chart's 5Y and All, and the widget's 1Y
   and longer drew `getMonthlyInvestments`: stored month-end snapshots whose
   first bucket is the end of the starting month, or a cost-basis stand-in for
   an account's first month. The line opened up to a month after the period the
   figures were measured over.

## Decisions (maintainer)

- "Value Change" on the investment charts is the securities-only change:
  `investedValueChange = IV(e) - IV(b)`.
- A long-range chart's first point is the previous market close the figures are
  measured from (`investedValueStart`, labelled by `startPriceDate`).

## The change

- **Server field.** `investedValueChange` on the period result, computed in
  `investedPeriodResult` and two-ended, so it survives an interior gap that
  withholds the P&L. Not a client subtraction, because `investedValueStart` and
  `investedValueEnd` are nulled with a withheld decision.
- **Sampled series.** `monthEndSampleDates` and
  `NetWorthService.getSampledInvestments` behind
  `GET /net-worth/investments-daily?sampling=monthEnd`, plus a `monthEnd`
  granularity on `investments-breakdown`. Every point is a day of the daily
  fold; All opens on the day before the first investment transaction
  (`loadFirstInvestmentDate`, extracted so the period result and the series
  share it).
- **Surfaces.** The report, the Investments chart and the dashboard widget
  request the sampled series for every non-daily range, label its ends by day
  and its middle by month (`sampledPointLabel`, `sampledTickLabel`,
  `monthEndAxisTicks`), and print Value Change (`investedValueChange`), Net
  Invested (`investmentCapitalFlows`) and Dividends and Interest
  (`investmentIncome`) beside the result, so change - net invested + income =
  result on screen.

## Not in this change

`GET /net-worth/investments-monthly`, `getMonthlyInvestments`,
`foldMonthlyInvestments`, `computeFirstActiveMonthCostBasis`,
`loadMonthlyCashBalances`, the `monthly` breakdown granularity and the client's
`netWorthApi.getInvestmentsMonthly` have no portfolio-chart caller once the
surfaces move. Removing them is a separate proposal (task 4).

## Verification

Backend: `invested-period-result.util.spec.ts`, `series-dates.util.spec.ts`,
`net-worth.service.spec.ts` (`getSampledInvestments`, the `monthEnd`
breakdown), `net-worth.controller.spec.ts`, `investment-inception.util.spec.ts`,
`portfolio-period-result.service.spec.ts`. Frontend: the three surfaces' tests
and `portfolio-chart-utils.test.ts`. By hand, on 1Y, 2Y, 5Y, All and a custom
window over a year, in both report views: the first point is labelled with the
previous close, the last is today, last less first is Value Change, and
Value Change - Net Invested + Dividends and Interest = Investment Result.
