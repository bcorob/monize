---
title: "Payroll deduction room is pooled per category across bills in the forecast; the suggestion is the year's mode"
author: Ken
date: 2026-10-27
branch: feat/payroll-deductions
id: l-2df11c51
scope: repo
status: active
src: agent
touches:
  - backend/src/common/date-utils.spec.ts
  - backend/src/common/date-utils.ts
  - backend/src/common/recurrence.ts
  - backend/src/payroll-deductions/dto/create-payroll-deduction-rule.dto.ts
  - backend/src/payroll-deductions/payroll-deduction-period.ts
  - backend/src/payroll-deductions/payroll-deduction-reset-reminder.service.ts
  - backend/src/payroll-deductions/payroll-deductions.controller.spec.ts
  - backend/src/payroll-deductions/payroll-deductions.controller.ts
  - backend/src/payroll-deductions/payroll-deductions.service.spec.ts
  - backend/src/payroll-deductions/payroll-deductions.service.ts
---

## Decided
- `frontend/src/lib/forecast.ts` no longer spends deductions inside `generateOccurrences`. Every surface calls `generateAllOccurrences(allSchedules, ...)`, which generates per schedule and then runs `spendPayrollDeductions`: one `DeductionPool` per `categoryId|currencyCode` built from every active bill's `payrollDeductions`, spent in date order across bills. Ken has two paycheques (mid-month and month-end) with the same tax categories; a per-bill walker let each spend the whole room, projecting twice the maximum. The pool is built from ALL schedules, not the surface's relevant ones, because the other paycheque may land in another account.
- When two rules on one category disagree, the lower maximum, lower remaining and earlier reset bind (the projection errs towards collecting, as the posting cap does). The server needs no change: `queryCategoryPeriodPaid` is already category-wide.
- `GET /payroll-deductions/suggest` answers the mode of the category's negative rows over the last 12 months (`SUGGESTION_WINDOW_MONTHS`, ties to the latest), source `ledger`, not the latest row: the last paycheque of a year is often capped or zeroed.
- `POST /payroll-deductions/batch` creates several categories of one bill in one `withScopedDb`; every ownership, duplicate and expected-amount check runs before the first save (`prepareLine`), and `create` delegates to `createMany` with one line. The form (`PayrollDeductionRuleForm` + `PayrollDeductionLineFields`) is bill-first with a `useFieldArray` of category rows; it offers only net-income bills (`payrollBillOptions`: `amount > 0`) and only the bill's deduction lines (`billDeductionCategoryIds`: categorised split lines with amount <= 0, so a zeroed line still qualifies), less categories already ruled.

## Tried and ruled out
- Sharing the pool while keeping the per-bill walk order: totals converge but the add-back lands on the wrong bill's dates (bill A's November instead of bill B's July).
- Looping the single-rule `create` from the client for several categories: a refused second line would leave the first written.

## Watch out
- `duplicate-functions.guard.spec.ts` only sees tracked files: the earlier commit's `daysInMonth` (now imported from `common/recurrence.ts`, exported for it) and `localToday` (now `todayInTimezoneOrUtc` in `common/date-utils.ts`, used by the warranty and payroll reminders) passed locally while untracked and failed once committed. Stage new files before `test:changed`.
- `loan-payment-frequency.guard.spec.ts` fails by one day under a local non-UTC `TZ`; it passes with `TZ=UTC`, which is what CI runs. `bond-price.service.spec.ts` has a wall-clock budget (< 1 s) that fails while a build runs beside it.
- A backgrounded Bash command here drops a leading `cd`; wrap it in `bash -c 'cd ... && ...'`.
- `getCategorySelectOptions` sorts alphabetically, so option-order assertions in form tests must not follow split order.
