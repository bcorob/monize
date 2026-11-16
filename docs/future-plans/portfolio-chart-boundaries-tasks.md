# Portfolio charts: one value change, one window -- Agent Task List

The task graph for `docs/future-plans/portfolio-chart-boundaries.md`. The
invariants are `docs/specs/portfolio-period-result.md` sections 10.2 to 10.5 and
10.9, INV-PORTRESULT-002 and INV-PORTCHART-001.

## Definition of done for every task

- Backend: `npm run lint && npx tsc --noEmit && npm run typecheck`, and
  `TZ=UTC npm run test:unit -- --coverage` at or above the thresholds.
- Frontend: `npm run lint && npm run type-check && npm run i18n:check`,
  `npm run test:cov` and `npm run build`.
- English strings first, then `npm run i18n:pseudo`, then every other locale as
  the final commit.

## Tasks

1. **[done] Invested value change.** `investedValueChange` in
   `backend/src/net-worth/invested-period-result.util.ts`, on the service's
   result type and the client type; spec cases for reconciliation and
   two-ended completeness.
2. **[done] Sampled series.** `monthEndSampleDates`
   (`backend/src/net-worth/series-dates.util.ts`),
   `NetWorthService.getSampledInvestments`, the `monthEnd` breakdown
   granularity, the `sampling` query parameter on `investments-daily`, and
   `loadFirstInvestmentDate` extracted to
   `backend/src/net-worth/investment-inception.util.ts`.
3. **[done] Surfaces.** `PortfolioValueReport`, `InvestmentValueChart` and
   `PortfolioValueWidget` request the sampled series on non-daily ranges and
   print the invested value change, net invested and income; the shared label
   and tick helpers in `portfolio-chart-utils.tsx`; the catalogs in every
   locale.
4. **[proposed] Remove the monthly investment series.** Delete the
   `investments-monthly` route, `getMonthlyInvestments`,
   `foldMonthlyInvestments`, `computeFirstActiveMonthCostBasis`,
   `loadMonthlyCashBalances`, the `monthly` breakdown granularity and
   `netWorthApi.getInvestmentsMonthly`, with their tests, and repoint the docs
   that name them (`docs/backend/securities-and-providers.md`,
   `docs/specs/portfolio-period-result.md` section 10.2's carried-basis
   wording). Needs its own agreement: it removes an API route.
