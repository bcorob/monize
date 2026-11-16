---
title: "Removing a category from an existing budget (#1931)"
author: Node
date: 2026-10-29
branch: claude/issue-1931
cost: { minutes: 6, tokens: 117983 }
touches:
  - "frontend/src/app/budgets/[id]/edit/page.test.tsx"
  - "frontend/src/app/budgets/[id]/edit/page.tsx"
  - frontend/src/components/budgets/BudgetCategoryForm.test.tsx
  - frontend/src/components/budgets/BudgetCategoryForm.tsx
  - frontend/src/i18n/messages/de/budgets.json
  - frontend/src/i18n/messages/en/budgets.json
  - frontend/src/i18n/messages/es/budgets.json
  - frontend/src/i18n/messages/fr/budgets.json
  - frontend/src/i18n/messages/hi/budgets.json
  - frontend/src/i18n/messages/id/budgets.json
---

## Decided
- The backend already had `DELETE /budgets/:id/categories/:categoryId` (`BudgetsService.removeCategory`) and `budgetsApi.removeCategory`; #1931 was frontend-only: a "Remove from budget" danger button in `BudgetCategoryForm` (optional `onRemove` prop) and a `ConfirmDialog` on `app/budgets/[id]/edit/page.tsx`.
- The edit modal closes before the confirmation opens (no stacked modals), and the confirmation closes before the request runs, so ConfirmDialog's lack of a busy state does not matter here.
- The confirm message states the consequence: `budget_period_categories` rows cascade on delete (`ON DELETE CASCADE` to `budget_categories`), so the line's history in past (closed) periods is erased; transactions are untouched.

## Tried and ruled out
- Soft-delete/archive of a budget line to keep closed-period history: needs a migration and every budget read to filter it; out of scope for the issue.

## Watch out
- Closed `budget_periods.total_budgeted` is a stored snapshot and is not recomputed after a line is removed, so a closed period's total can exceed the sum of its remaining period categories.
- In the edit page test, a cancel click that ends the test synchronously trips `act-guard`; await the dialog's disappearance with `waitFor`.
