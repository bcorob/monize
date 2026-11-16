---
title: "PR 1883 accrual basis defaults to accrual, making every transaction read rebuild the whole ledger in CTEs"
author: Ken
date: 2026-10-27
branch: feat/accrual-accounting
id: l-4f7c3807
scope: repo
status: active
src: agent
touches:
  - database/migrations/20261020164803_accrual_persistence.sql
  - backend/src/accruals/reporting-basis.ts
  - backend/src/accruals/reporting-query.ts
---

## Watch out
- `user_preferences.reporting_basis` defaults to 'accrual' (database/migrations/20261020164803_accrual_persistence.sql, schema.sql) and `resolveReportingBasis` (backend/src/accruals/reporting-basis.ts) falls back to "accrual". Every existing user is therefore in accrual mode even with `accrual_enabled=false` and zero `accrual_schedules`; the setting only hides the UI.
- In accrual mode `reportingEntities`/`applyReportingBasis` (backend/src/accruals/reporting-query.ts) prepend `reportingFactCtes` (reporting-facts-sql.ts), which shadow `transactions`, `transaction_splits`, the tag tables and `investment_transactions` with CTEs over the user's entire ledger. They are referenced more than once, so Postgres materializes them: no index access, and outer filters such as `account_id IN (...)` cannot be pushed down.
- Measured 2026-10-27 on the dev DB (35.7k transactions, 10.3k splits): the account-register COUNT(DISTINCT) query took 48s. About 34s went to materializing the `transactions` CTE; the linked/parent self-join hashes spilled (8192 batches from 1, consistent with NULL-key skew). About 14s went to a nested loop of the 641-row CTE against 10,281 `transaction_splits` CTE rows (6.6M rows filtered). The core `recognition_components`/`recognition_parents` CTEs alone take about 100ms; their correlated EXISTS becomes a hashed subplan and is not the problem.
## Decided
- To diagnose, capture full SQL with `ALTER SYSTEM SET log_min_duration_statement='5s'` + `pg_reload_conf()`, then reset it. pg_stat_activity truncates the query at 1KB, and pg_stat_statements is not installed.
