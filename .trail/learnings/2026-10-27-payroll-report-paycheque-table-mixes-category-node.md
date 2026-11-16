---
title: "Payroll report paycheque table mixes category periods; ledger dates need clamping to the report's years"
author: Node
date: 2026-10-27
branch: claude/issue-1886
cost: { minutes: 3, tokens: 38091 }
touches:
  - backend/src/payroll-deductions/dto/payroll-deduction-report-query.dto.ts
  - backend/src/payroll-deductions/payroll-deduction-report.spec.ts
  - backend/src/payroll-deductions/payroll-deduction-report.ts
  - docs/specs/payroll-deductions.md
  - frontend/src/components/reports/PayrollDeductionsReport.test.tsx
  - frontend/src/components/reports/PayrollDeductionsReport.tsx
  - frontend/src/components/reports/PayrollDeductionsReportTables.tsx
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/en/reports.json
  - frontend/src/i18n/messages/es/reports.json
---

## Decided
- `paychequeCell` (frontend/src/components/reports/PayrollDeductionsReportTables.tsx) tells an absent amount apart: a counted paycheque with no line is a known zero; one outside the category's own period (a different reset date) or in another currency is "Outside its period" / "Other currency", and empty in the CSV.
- The report reads the ledger only inside `PAYROLL_REPORT_MIN_YEAR`..`PAYROLL_REPORT_MAX_YEAR` (backend/src/payroll-deductions/payroll-deduction-report.ts, which the query DTO imports), and drops a period starting before the minimum year.

## Watch out
- Transaction dates are unbounded but the report's `year` is 1900..2100: anything derived from ledger dates (`availableYears`, the history range) must stay inside that range, or the picker offers a year the route refuses.
