---
title: Built-in report SQL must name the investment exclusion in the literal
author: Node
date: 2026-10-20
branch: claude/issue-1787
cost: { minutes: 3, tokens: 21459 }
touches:
  - backend/src/built-in-reports/tax-recurring-reports.service.spec.ts
  - backend/src/built-in-reports/tax-recurring-reports.service.ts
---

## Decided
- Supersedes the `recurringSpendingRows(t, a)` helper named in the earlier 1787 review learning: it was removed. The recurring query and its history subquery spell the clauses inline, the subquery through HISTORY_INVESTMENT_EXCLUSION_NO_SPLITS / HISTORY_REPORTABLE_TX_AMOUNT (aliases h, ha).

## Watch out
- src/common/investment-filter.guard.spec.ts reads every template literal containing `FROM transactions` in built-in-reports/*.service.ts and requires the substrings `INVESTMENT_EXCLUSION` and `REPORTABLE_TX_AMOUNT` in it (or `${INVESTMENT_EXCLUSION}` when splits are joined). Wrapping the predicate in a helper function call hides them and fails the guard, so name constants in the literal.
- Running only `jest src/built-in-reports/` does not run that guard; include src/common/investment-filter.guard.spec.ts when touching report SQL.
