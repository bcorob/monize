# Plan: payroll deductions (Taxes tool)

Executes `docs/specs/payroll-deductions.md`. Read the spec first; this plan says
what to edit, what to run and what to observe, and restates the assumptions so
a fresh session can pick up any phase.

## Assumptions (verified against the tree, 2026-10-26)

- A paycheque is a split scheduled deposit on `scheduled_transactions`; its
  deduction lines are negative `scheduled_transaction_splits` of kind
  `category`. Posting builds `transactionPayload.splits` under the schedule
  lock in `ScheduledTransactionsService.post` and re-sums the parent when a
  line changes (the loan allocation already does this).
- The forecast is projected in the browser by `frontend/src/lib/forecast.ts`;
  both the Bills chart and the dashboard widget read
  `scheduledTransactionsApi.getAll()`, so a field on the read model reaches both.
- Notifications are written only through `NotificationDispatchService.notify`;
  a dedupe key is the idempotency mechanism for a cron-raised row.
- The Tools menu is `TOOLS_LINKS` in `frontend/src/lib/nav-links.ts`; every
  link needs an icon and a `navigation` catalog label.

## Phases (one PR)

### Phase 1 -- schema and backend

- Migration and `schema.sql`: `payroll_deduction_rules` with its RLS policy.
- `backend/src/payroll-deductions/`: entity, DTOs, period and cap helpers,
  service (CRUD, suggestion, figures), controller, reminder cron, module.
- `ScheduledTransactionsService`: the posting cap and the `payrollDeductions`
  read-model field.
- Notification type, email copy, backup classification, allowlist entry,
  `docs/cron-jobs.md` row, invariants.
- Run: `npm run lint && npx tsc --noEmit && npm run typecheck`,
  `npm run test:unit -- payroll`, `npm run migration:lint`.

### Phase 2 -- frontend

- Tools entry, `/taxes` landing, `/taxes/payroll-deductions` page with the
  rule form and the collapsed year-to-date table.
- `lib/forecast.ts`: spend the room per occurrence, refill after the period.
- Notification copy and target.
- Run: `npm run lint && npm run type-check && npm run i18n:check`,
  `npm run test -- payroll forecast nav-links`.

## What should be observed

- Posting the paycheque in a period whose EI room is 53.48 writes an EI line
  of -53.48 and a parent 10.52 higher than the template.
- The forecast shows the paycheque rising by the EI amount once the room is
  spent, and falling back on the first occurrence after the reset date.
- Changing a rule in October leaves every row posted before October exactly
  as it was.
