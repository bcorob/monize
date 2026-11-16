# Plan: report breakdown by tag key

Executes `docs/specs/report-tag-key-breakdown.md`. Read the spec first; this plan
says what to edit, what to run, and what to observe, and restates the
assumptions so a fresh session can pick up any phase.

## Assumptions (verified against the tree, 2026-09)

- The tag primitive is complete: `tags`, `transaction_tags`,
  `transaction_split_tags`, the `tags` module, the `KEY:VALUE` convention on both
  layers (`tag-key-value.util.ts` / `tag-key-value.ts`), and the value-aggregation
  precedent `TransactionAnalyticsService.getTransactionBreakdownByTagKey`. This
  feature adds NO tag storage.
- Built-in reports live in `backend/src/built-in-reports/`. Income vs Expenses
  and Cash Flow share `IncomeReportsService.getIncomeVsExpenses`. The canonical
  filters `investmentExclusionSql` / `reportableTransactionAmountSql`
  (`backend/src/common/investment-filter.util.ts`) decide investment membership
  and must stay on every branch (INV-REPORT-001).
- Reports currently exclude ALL transfers (`t.is_transfer = false` plus the split
  transfer-leg predicate). This feature relaxes that ONLY for the new
  tagged-flows figure, ONLY when `tagKey` is set (INV-REPORT-003).
- The report response already carries an FX-completeness model
  (`missingCurrencies`, `excludedCount`, `totals === null` when incomplete);
  every new bucket must preserve it per bucket.

## Phases (each phase is one PR)

### Phase 1 -- Income vs Expenses + Cash Flow (the core; solves the reporter's case)

The highest-value slice: it is the report the discussion is about, and it carries
the transfer-flow model. Everything in the spec's sections 1-4 and section 3.

- Backend: extend the query DTO with `tagKey`; thread it through the controller
  and `getIncomeVsExpenses`; compute the All bucket (unchanged), the per-value
  buckets, the untagged bucket, and `taggedInflows`/`taggedOutflows`, each on the
  existing per-currency + completeness path. New response fields are additive.
- Frontend: "Break down by tag key" `Select` in `IncomeVsExpensesReport` and the
  Cash Flow report; render value buckets, the untagged bucket, and the tagged
  flows as a distinct labelled pair; API-client `tagKey` param; response types.
- Tests: the full section-9 matrix for these two reports (parity, partition,
  transfer visibility, double-count, VOID, investment linkage, FX-per-bucket) +
  the frontend cases + one E2E smoke.
- i18n: the `reports.tagBreakdown.*` keys, English-first, then every locale.

Observable when done: switching "Break down by tag key" to `scope` on Income vs
Expenses shows Household / Stall / (untagged) buckets; a tagged RRSP->Checking
transfer shows under Household as a tagged inflow and adds nothing to income.

### Phase 1b -- account scope and the funding series (Income vs Expenses)

Follow-up from the reporter's screenshots; spec section 10. C: an account
multi-select on `IncomeVsExpensesReport` (the backend already honours
`accountIds`; Cash Flow follows in Phase 1c). B:
`IncomeExpenseTagPeriodItem` (per-period `taggedInflows` / `taggedOutflows`) in
each bucket, and two indigo series on the main chart for the active non-untagged
bucket. Order: spec commit, backend (DTO, both flow queries, tests), frontend
(types, controlled `TagKeyBreakdownBuckets`, report), translations last.

### Phase 1c -- opt-in stacking and Cash Flow parity

Spec section 10.7. An opt-in, default-off "Stack tagged flows" switch (inflows
on the Income / Inflows bar, outflows on the Expenses / Outflows bar; presentation
only, INV-REPORT-003 unchanged) on Income vs Expenses and Cash Flow, and Cash Flow
parity: account filter sent to all three endpoints (`income-by-source` gains
`accountIds`), controlled breakdown tabs, tagged series. Order: extract the
Income vs Expenses table (file size), spec, backend (`cash-flow` and
`income-by-source` `accountIds`), frontend, translations last.

### Phase 1d -- internal transfers and the Balance view

Spec sections 10.8 and 10.9. Backend: with `accountIds`, a tagged transfer leg
whose counterpart account is also selected is left out of the tagged flows (whole
transfer via `linked_transaction_id`, split leg via `transfer_account_id`).
Frontend: the stacking switch becomes "Include tagged transfers" and, when on,
shows Balance and Balance % (one pure helper) in the chart, tooltip, cards,
table and CSV of Income vs Expenses and Cash Flow. Order: spec, backend,
frontend, translations last.

### Phase 2 -- the funding view on Income by Source, Spending by Category and Monthly Breakdown

Spec section 11. The reporter wants regular income plus transferred money as the
month's available spending money, compared with actual expenses, in reports and
graphs. Each report gets the account filter (Monthly Breakdown also on the
server), a tag key + value control and the "Include tagged transfers" switch;
nothing changes while the key, the value or the switch is off. Shared pieces
first (`taggedFunds`, `collectTagValues`, `useTaggedFundsFilter`,
`useTaggedFunding`, `TaggedFundsControls`, `TaggedFundsStrip`), then one commit
per report: Income by Source (a distinct "Tagged transfers: <value>" entry and
an Available funds total, shares untouched), Spending by Category
(`tagKey`/`tagValue` filter on the server, plus the Available funds / Spent /
Balance strip), Monthly Breakdown (`accountIds` on both queries, a per-month
Balance summary block in new files). Value partitioning of Income by Source and
Spending by Category stays deferred (spec 11.7).

### Phase 3 -- Budget vs Actual funding overlay

Spec section 11.6, replacing the earlier "deferred" decision. Frontend only: an
Available funds series (income + tagged inflows - tagged outflows per month, from
the Income vs Expenses answer) beside Budgeted and Actual, with "Actual vs
available" in the tooltip. Budget figures are untouched; months align by
`monthKey`; a month missing from either side is unknown, not 0.

### Not in scope: a rules engine

Auto-tagging by condition (source/destination account, payee, amount, etc.) is
explicitly excluded by owner decision. Tags are applied manually through the
existing transaction-form tag control; nothing in this feature writes a tag on a
user's behalf.

## What to run (per phase, before pushing)

- `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`,
  `TZ=UTC npm run test:unit -- --coverage`, and (the SQL changes a query)
  `npm run build && npm run test:integration`.
- `frontend/`: `npm run lint && npm run type-check && npm run i18n:check &&
  npm run test:cov && npm run build`.
- `docs`: `node scripts/check-docs-manifests.mjs` and
  `node scripts/check-env-docs.mjs` from the root; `backend`'s
  `doc-paths.spec.ts` after staging new files.
- Name INV-REPORT-001, INV-REPORT-003, INV-TRANSFER-001 and the FX-completeness
  contract in the PR body; tick the template; link discussion #1381.

## Sequencing note for agents

The backend response shape (section 4) is the contract between layers. Land the
backend DTO + response types first (or in the same PR, backend before frontend),
because the frontend types mirror them. The parity guard (I1) is the first test
to write: it fails the moment a no-`tagKey` response drifts, which is the cheapest
possible early warning while the query is being reshaped.
