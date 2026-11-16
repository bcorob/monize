---
title: "Payroll Deductions report reads the cap's row SQL; a closed year's maximum is not recorded"
author: Node
date: 2026-10-27
branch: claude/issue-1886
cost: { minutes: 21, tokens: 382073 }
touches:
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
  - frontend/src/i18n/messages/ko/reports.json
  - frontend/src/i18n/messages/nl/reports.json
  - frontend/src/i18n/messages/pl/reports.json
---

## Decided
- The report endpoint is `GET /payroll-deductions/report?year=` in the payroll module, not under `built-in-reports/`: it needs the rules, and both are owner-only for a delegate anyway (built-in-reports carries no `@DelegateRequiresSection`). The frontend registers it as built-in report `payroll-deductions` under the Tax section.
- The rows "paid" sums are one SQL fragment, `CATEGORY_DEDUCTION_ROWS_SQL` in `payroll-deduction-cap.ts`; `queryCategoryPeriodPaid` and `queryDeductionTransactions` (the report, one query per category over the whole ledger, bucketed into periods in TS) both read it, so the report's current period matches the page and the cap.
- A selected year is each category's period that STARTS in that year on its reset date (`periodStartingIn`).
- A rule stores only its current maximum, so the report returns `yearlyMaximum`/`remaining`/`percentOfMaximum`/`maximumReachedOn` as `null` for a closed period and the UI says "Not recorded".

## Watch out
- `ReportSwitcher.test.tsx` and `app/reports/page.test.tsx` assumed Tax held exactly one report; a new report in a section can break "only report in its section" assertions.
- `InvestmentTransactionForm.test.tsx` timed out once under the full frontend `test:changed` run (822 files) and passes alone.
