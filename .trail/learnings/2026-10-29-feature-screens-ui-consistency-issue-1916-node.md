---
title: "Feature screens UI consistency (issue 1916): decisions and rejected items"
author: Node
date: 2026-10-29
branch: claude/issue-1916
cost: { minutes: 26, tokens: 115437 }
touches:
  - frontend/src/app/bills/page.test.tsx
  - frontend/src/app/bills/page.tsx
  - frontend/src/i18n/messages/de/aiReview.json
  - frontend/src/i18n/messages/de/bills.json
  - frontend/src/i18n/messages/de/budgets.json
  - frontend/src/i18n/messages/de/categories.json
  - frontend/src/i18n/messages/de/emailReceipts.json
  - frontend/src/i18n/messages/de/institutions.json
  - frontend/src/i18n/messages/de/payees.json
  - frontend/src/i18n/messages/de/rules.json
---

## Decided
- Bills List/Calendar is ViewModeToggle on a new 'bills' surface of viewModeStore (layers ['transactions'], same storage key); a ?highlight= link forces the list, because only the list draws rows.
- New density views: 'rules', 'aiReviews', 'emailReceipts' in densityStore.
- Budgets list is a table (BudgetList, useLongPress rows, EmptyState inside); budget and warranty detail pages gained EntitySwitcher wrappers (BudgetSwitcher, WarrantySwitcher); warranty detail gained a SummaryCard row.
- Bulk payee dialogs: Modal title + description tooltip; a backup warning before a bulk merge stays in the body (one-time warning).
- Help URLs: Tags, Warranties, Email-Receipts, Accounts#financial-institutions exist on the wiki; Rules and the AI review inbox have no wiki page, so D16 was rejected for both.

## Tried and ruled out
- Sorting RulesList (its order is execution order), the AI review inbox (newest 50 only) and the email receipt list (server-paged, no sort param): density and phone layout only.
- TagList phone card: removed on purpose by an earlier device review; kept off.
- ConfirmDialog for ReactivatePayeeDialog: it cannot disable its buttons while the request runs.
- Budgets D7 "pill": it was a status badge, not a filter; converted to Badge, no filter added.

## Watch out
- A worktree installed with npm ci --ignore-scripts skips patch-package, so src/test/next-body-streams.test.ts fails until `npx patch-package` runs.
- InvestmentTransactionForm.test.tsx can time out under a full test:changed run and passes alone.
- Seven parallel edit agents worked safely with tests serialized through `flock /tmp/<lock>`; the lead shrank ui-conventions baselines and did the locales.
