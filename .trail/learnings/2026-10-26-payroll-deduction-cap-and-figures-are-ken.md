---
title: "Payroll deduction cap and figures are plain functions over the posting's EntityManager, so no module edge or cycle"
author: Ken
date: 2026-10-26
branch: feat/payroll-deductions
id: l-3b506536
scope: repo
status: active
src: agent
touches:
  - backend/eslint.config.mjs
  - backend/src/app.module.ts
  - backend/src/backup/backup-format.ts
  - backend/src/backup/export-table-queries.ts
  - backend/src/backup/restore-plan.ts
  - backend/src/backup/restore-references.ts
  - backend/src/backup/restore-wipe.ts
  - backend/src/backup/support-backup/support-backup-integrity.ts
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/i18n/locales/de/emails.json
---

## Decided
- The payroll deduction cap and the read-model figures are plain functions over the caller's `EntityManager` (`backend/src/payroll-deductions/payroll-deduction-cap.ts`, `payroll-deduction-read-model.ts`), not methods on `PayrollDeductionsService`. `ScheduledTransactionsService.post` and `findAll` import them directly, so `PayrollDeductionsModule` imports only `NotificationsModule` and no module cycle through `ScheduledTransactionsModule -> PayrollDeductionsModule -> NotificationsModule -> ScheduledTransactionsModule` exists (`module-graph.spec.ts` stays untouched).
- The cap sits in `post()` just before `options.beforeWrite`, after the loan allocation blocks, gated on `useSplits && !isInvestment && !preparedTransfer && !fx && !skipFinancialWrite` and no investment line; the parent is re-summed only when a line changed, which keeps `validateSplitAmountSum` satisfied.
- The forecast reads each rule's `remaining` from the scheduled read model's `payrollDeductions` instead of summing transactions client-side, because the ledger is read once on the server under one definition (`payroll-deduction-cap.ts`) and the three builders (`buildForecast`, `buildMultiAccountForecast`, `getProjectedBalanceAtDate`) share `generateOccurrences`: spending the room there (`deductionWalker` in `frontend/src/lib/forecast.ts`) reaches every surface without touching the Bills chart or the dashboard widget.
- `PAYROLL_DEDUCTION_RESET_DUE` is filed under PAYMENTS through the existing BILL_DUE/SCHEDULED_POST_FAILED special case in `notificationCategoryOf`, so no new preference-matrix category, no channel defaults and no frontend matrix mirror were needed.

## Tried and ruled out
- Injecting `PayrollDeductionsService` into `ScheduledTransactionsService`: it would need `forwardRef` on both module edges and a new entry in the module-graph spec for a dependency the plain functions make unnecessary.
- Adjusting `effectiveAmount` on the read model for the capped next occurrence: the forecast would then double-apply the first occurrence's cap, and every other consumer of `effectiveAmount` would need to know whether it was already capped. The bills list keeps the template amount; only the posting and the forecast apply the cap.

## Watch out
- `scheduled-transactions.service.spec.ts` registers every entity `getRepository` may ask for in `createScopedDbMocks`; a new `m.getRepository(X)` in `post()` or `findAll()` throws "no mock repository registered" across the whole suite until `[X, repo]` is added there.
- A new `NotificationType` member fails `notification-email-copy.spec.ts` at compile time until the `examples` record (a `satisfies Record<Exclude<NotificationType, PACE_WARNING>, ...>`) carries a sample, and fails its `all active types have translated titles` cases for every locale until `backend/src/i18n/locales/<locale>/emails.json` has the copy.
- Frontend `messages.parity.test.ts` and backend `locales.parity.spec.ts` need every one of the 18 full locales (not en-GB/en-US, which are variant overlays) to carry a new namespace and every new key; a JSON round-trip with `json.dumps(indent=2, ensure_ascii=False)` reproduces the catalogs byte for byte, so a script can insert keys in en's position.
- `npm run build` from a backgrounded shell whose `cd` is dropped runs in the repo root, where there is no `build` script; pass the directory explicitly.
- Four `react-hooks/set-state-in-effect` lint errors (CalendarMonthPicker, CalendarPopover, NumericInput, useTransactionFilters) exist on main with this machine's eslint plugin version and are unrelated to this feature.
