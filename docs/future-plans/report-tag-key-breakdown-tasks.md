# Tasks: report breakdown by tag key

Task list for `docs/future-plans/report-tag-key-breakdown.md`. Phase 1 is
complete except the E2E smoke; Phases 2-3 are stubs. Check a box only when its
gate (the plan's "What to run") passes and is quoted in the commit/PR.

## Phase 1 -- Income vs Expenses + Cash Flow

### Backend

- [x] Add `tagKey?: string` to `IncomeVsExpensesQueryDto` (trimmed, `@IsString`,
      `@MaxLength(100)`); new `CashFlowQueryDto` carrying the same field.
- [x] Thread `tagKey` through `built-in-reports.controller.ts` (both
      `income-vs-expenses` and `cash-flow`) into `getIncomeVsExpenses` options.
- [x] `getIncomeVsExpenses`: unchanged response when `tagKey` absent (I1);
      per-value + untagged + All buckets on the shared completeness path when set.
- [x] `taggedInflows`/`taggedOutflows` per value from transfer legs (two
      separate whole-transfer and split-leg queries, F-GUARD-001 safe), never
      folded into income/expenses/net (INV-REPORT-003).
- [x] Reuse the tag key/value SQL and split-tag subquery shape; keep
      `investmentExclusionSql` and the VOID exclusion on every branch.
- [x] Additive response types in `built-in-reports/dto/`.

### Backend tests

- [x] Unit parity (I1), value partition (B1-B4), split-tag no fan-out (B4/I7),
      transfer visibility (I2/I3), VOID (I6), investment linkage (I5), FX per
      bucket (I4). `TZ=UTC npm run test:unit -- --coverage` green (thresholds met).
- [x] Real-PG integration spec `test/integration/report-tag-key-breakdown.integration.spec.ts`
      (9 cases, run against live PostgreSQL 16, 9/9 pass).

### Frontend

- [x] `TagKeyBreakdownSelect` (hidden with no `KEY:VALUE` tags; "None" sends no
      `tagKey`) via `useTagKeys` + `collectTagKeys`.
- [x] `TagKeyBreakdownBuckets` (value + untagged buckets; tagged flows in a
      distinct card, never as income); reuses `Card`, `Tabs`, `PartialTotal`.
- [x] `built-in-reports.ts` passes `tagKey`; response types mirror the backend.
- [x] Frontend tests (selector hidden/shown, "None" unchanged, buckets + flows,
      incomplete bucket). lint / type-check / i18n:check / ui-conventions /
      test:cov green.

### i18n

- [x] `reports.tagBreakdown.*` in `en` + generated `xx`, then translated into all
      18 non-English locales (en-GB/en-US inherit from en). Parity gate green.

### E2E

- [ ] Smoke: tag two transactions under `scope`, open Income vs Expenses, switch
      the breakdown to `scope`, see value tabs + a tagged-transfer flow figure.
      (Deferred: the full E2E stack is disproportionately costly to stand up in
      the current environment; backend integration + frontend component tests
      cover the behaviour. Run before merge where the stack is available.)

## Phase 1b -- Account scope and the funding series (Income vs Expenses)

Spec section 10.

- [x] Backend: `IncomeExpenseTagPeriodItem`; both flow queries grouped by the
      period start; per-period flows sum to the window figures; tests (unit +
      integration) for periods, `accountIds` with `tagKey`, FX per period.
- [x] Frontend: `ReportAccountMultiSelect` on `IncomeVsExpensesReport` (persisted,
      empty = all; Cash Flow follows in Phase 1c); `TagKeyBreakdownBuckets`
      controlled mode; two indigo series, table columns and tooltip for the
      active non-untagged bucket.
- [x] i18n: `reports.tagBreakdown.inflowsSeries` / `outflowsSeries`.

## Phase 1c -- Opt-in stacking and Cash Flow parity

Spec section 10.7.

- [x] Refactor: `IncomeVsExpensesTable` extracted (the report was at the file
      size limit); no behaviour change.
- [x] Backend: `CashFlowQueryDto.accountIds` passed through the controller;
      `income-by-source` `accountIds` (DTO, service, `ANY($n::uuid[])`); other
      callers of `getIncomeBySource` unchanged; unit + integration tests.
- [x] Frontend: client serialises `accountIds` for `getCashFlow` and
      `getIncomeBySource`; shared active-bucket hook and stacking switch;
      Income vs Expenses stacking (default off, persisted); Cash Flow account
      filter on all three calls, controlled tabs, tagged series, stacking.
- [x] i18n: `reports.tagBreakdown.stackFlows`; every locale last.

## Phase 1d -- Internal transfers and the Balance view

Spec sections 10.8 and 10.9.

- [x] Backend: exclude a tagged transfer leg whose counterpart is also in
      `accountIds` (whole transfer and split leg); truth table in unit and
      integration tests.
- [x] Frontend: `tagged-balance.ts` helper; "Include tagged transfers" switch;
      Balance and Balance % on Income vs Expenses and Cash Flow (chart, tooltip,
      cards, table, CSV); completeness via `PartialTotal`.
- [x] i18n: `reports.tagBreakdown.includeTransfers` and the Balance labels; the
      old `stackFlows` key removed if unused; every locale last.

## Phase 2 -- Funding view on Income by Source, Spending by Category, Monthly Breakdown

Spec section 11.

- [x] Shared: `taggedFunds` (`lib/tagged-balance.ts`), `collectTagValues`,
      `useTaggedFundsFilter`, `useTaggedFunding`, `useReportAccountScope`,
      `TaggedFundsControls`, `TaggedFundsStrip`.
- [x] Income by Source: account filter, controls, "Tagged transfers: <value>"
      entry and Available funds, shares unchanged; i18n.
- [x] Spending by Category: backend `tagKey` + `tagValue` filter (DTO, shared
      `tagValuesArrayExpr`, unit + integration); frontend account filter,
      controls, Available funds / Spent / Balance strip.
- [x] Monthly Breakdown: backend `accountIds` (DTO, both queries, unit +
      integration); frontend account filter, controls, per-month summary block in
      new files (the report file only gains wiring).
- [x] i18n: every locale last.

## Phase 3 -- Budget vs Actual funding overlay

Spec section 11.6.

- [x] Frontend: controls, funding fetch aligned by `monthKey`, Available funds
      series, tooltip rows, completeness note; budget figures unchanged.
- [x] i18n: every locale last.
