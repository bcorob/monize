# Tasks: payroll deductions

Task list for `docs/future-plans/payroll-deductions.md`. Check a box only when
its gate passes and is quoted in the commit or PR.

## Phase 1 -- schema and backend

- [x] Migration `payroll_deduction_rules` + `database/schema.sql` + RLS policy.
- [x] Entity, create/update DTOs, `payroll-deduction-period.ts`,
      `payroll-deduction-cap.ts`, service, controller, module, app registration.
- [x] Posting cap in `ScheduledTransactionsService.post` (base, override and
      inline splits), parent re-summed.
- [x] `payrollDeductions` on the `findAll` read model.
- [x] `PAYROLL_DEDUCTION_RESET_DUE` type, email copy, reminder cron, allowlist,
      `docs/cron-jobs.md` row.
- [x] Backup export query and support-backup rules.
- [x] Unit specs: period, cap, service, controller, cron, guard.

## Phase 2 -- frontend

- [x] `TOOLS_LINKS` Taxes entry, icon, label; nav-links test.
- [x] `/taxes` landing and `/taxes/payroll-deductions` page, form, list,
      collapsed year-to-date table; `taxes` namespace.
- [x] `lib/forecast.ts` deduction walk; forecast tests.
- [x] Notification type, copy and catalog entry.
- [x] Pseudo-locale regenerated; `lint`, `type-check`, `i18n:check`, focused tests.

## Not in this PR

- [ ] Translations of every other locale (the final commit on the PR).
- [ ] E2E smoke of the page.
