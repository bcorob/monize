---
title: A payroll occurrence projects as template minus its current line plus the deduction due; adding back the shortfall double-counts a zeroed line
author: Ken
date: 2026-10-27
branch: feat/payroll-deductions
id: l-f1e134ef
scope: repo
status: active
src: agent
touches:
  - backend/src/payroll-deductions/payroll-deduction-cap.ts
  - backend/src/payroll-deductions/payroll-deduction-read-model.ts
  - backend/src/payroll-deductions/payroll-deduction-reset-reminder.service.ts
  - backend/src/payroll-deductions/payroll-deductions.controller.spec.ts
  - backend/src/payroll-deductions/payroll-deductions.controller.ts
  - backend/src/payroll-deductions/payroll-deductions.service.spec.ts
  - backend/src/payroll-deductions/payroll-deductions.service.ts
  - docs/frontend/financial-figures.md
  - docs/specs/payroll-deductions.md
  - docs/system-invariants.md
---

## Decided
- `spendPayrollDeductions` (frontend/src/lib/forecast.ts) projects each paycheque at `template + lineAmount - applied`, where `lineAmount` is what the template already deducts for the category (its negative line, or 0 when the figure was entered because the line is absent or zero) and `applied = min(expected, room)`. Ken's template already had the deductions zeroed at this year's maximum; the earlier "add back expected - applied" raised the rest of this year's pay and then showed the new year at the template, when it should stay flat and drop after the reset.
- The Edit Occurrence dialog takes `payrollDeductions` (category id to deducted magnitude) from `projectPayrollOccurrence`, the same pooled walk, and reseeds the template's split lines and parent; an override with its own lines or a stated amount, and a `prefillAmount`, outrank it. Wired from `handleDatePickerSelect` in app/bills/page.tsx like `loanOccurrence`.
- The pool steps resets with `nextAnniversary(resetDate, after)` from the rule's `resetDate` (now on the read model), so a leap-day anchor returns to the 29th; an occurrence with `spendDate < pool.periodStart` is a closed period's and is left alone.
- `GET /payroll-deductions/suggest` with `resetDate` also estimates the maximum (`estimateMaximum`): the current period's total when the bill's postings show the deduction stopped (`deductionStopped` reads `scheduled_transaction_postings` joined to `transactions`; transactions carry no schedule id of their own), else the higher of the current and last full period.
- `GET /payroll-deductions/history` answers the last five closed periods per category and currency; the page loads it only when the collapsed section opens.

## Tried and ruled out
- Adding back only for `line`-sourced rules: right this year, but still misses the drop after the reset for a zeroed line.

## Watch out
- `loadScheduledPayrollDeductions` runs one ledger query per rule; `memoisedPaidLookup` dedupes per (category, period, currency) within one read, which is what two paycheques on one category need.
- A guard test on tracked files only (duplicate-functions, cache-prefix-classification, number-locale) passes while a new file is untracked; `git add -N` first.
- `expect(controller.method(...)).rejects` does not catch a synchronous throw from a controller's own validation; use `expect(() => ...).toThrow`.
