---
title: Transactions page reload effect ignores a resolved-sort change that no click made
author: Ken
date: 2026-10-26
branch: feat/transactions-phone-date-toggle-sort-row
id: l-874ce7bc
scope: repo
status: active
src: agent
touches:
  - docs/frontend/tables-and-registers.md
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/transactions/TransactionList.mobileWrapped.test.tsx
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/hooks/useRegisterPhoneCard.ts
  - frontend/src/lib/transaction-sort.test.ts
  - frontend/src/lib/transaction-sort.ts
---

## Decided
The phone card (a phone at Normal density, `useRegisterPhoneCard` in frontend/src/hooks/) shows no Description or Ref #, so the phone sort strip in TransactionList.tsx drops those chips (`PHONE_CARD_OMITTED_SORT_FIELDS`, frontend/src/lib/transaction-sort.ts), and `resolveRegisterSort` takes a `phoneCard` flag so a remembered sort on either falls back to date while the card is drawn, storage untouched, the same as the Account and hidden-column rules. The date toggle and select-all now lead the sort-chip row instead of sitting in a slim row above it.

## Watch out
The page's reload effect (frontend/src/app/transactions/page.tsx) reads the sort from `registerSortRef` and re-runs only on filters, page, undo/redo and `sortRequestTick`. A resolved sort that changes with no click (a density or viewport switch, a column hidden or shown) changes the headers but does NOT refetch the rows. The phone card case has its own dep, `phoneCardHoldsSortBack`, which also resets to page 1. Hiding the currently sorted column still has the gap: headers fall back to date, rows stay in the old order until the next reload.
In page.test.tsx, resetting a zustand store (useDensityStore) in `finally` while the page is mounted re-renders it outside act and fails the act guard; unmount first.
