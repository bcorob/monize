---
title: UI docs vs code gaps found reviewing issue 1914
author: Node
date: 2026-10-29
branch: claude/issue-1914
cost: { minutes: 7, tokens: 29034 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - docs/frontend/ui-conventions.md
---

## Decided
- New Transaction's submit labels ("Create {mode}", "Create {mode} & New", "Update {mode}" in transactions.json) are the rule for a SplitSubmitButton form; "Save" / "Save Changes" applies to a plain save button.
- SortableHeader (focusable th with tabIndex and onKeyDown, aria-sort) is an accepted keyboard pattern for report tables; list headers hold a button inside th aria-sort.

## Tried and ruled out
- Claiming every TransactionForm host uses one Modal size: false. Investments page and InvestmentRegisterPanel cash forms, warranty detail and the payee/category transaction tabs differ; listed as debt in screens-and-dialogs.md.

## Watch out
- TransactionFilterPanel's fold toggle is a div onClick, not keyboard reachable.
- ColumnChooserMenu.test.tsx and TransactionsCalendarView.test.tsx assert the redundant tabular-nums class; removing it means updating those assertions.
