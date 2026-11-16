---
title: Converting a transaction to/from a transfer keeps the row and reuses the create and delete paths
author: Node
date: 2026-10-30
branch: claude/issue-1937
cost: { minutes: 35, tokens: 469432 }
touches:
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
---

## Decided
- Conversions (issue #1937) live in `TransactionConversionService` with two owner-only routes, `POST /transactions/:id/convert-to-transfer` and `.../convert-to-transaction`; the row keeps its id, only the counterpart is created or removed.
- `transferLegColumns` is the one column set for a transfer leg: `writeTransferLegs` creates from it and the conversion writes the kept row with its side, so a converted leg is a created one.
- Transfer -> transaction detaches the pair under both legs' locks, removes the counterpart through `removeLockedTransactionLeg`, then calls `TransactionsService.update(..., { recordHistory: false })` inside the same `withScopedDb`; the conversion records its own history entry and `undoTransactionUpdate` refuses it (`UNDO_CONVERSION`).
- Reconciled counterpart: client warns (CLEARED or RECONCILED), server blocks only under "Lock reconciled transactions" via `assertReconciledRowsMutable` over both legs.
- The form offers all three tabs on an edit except a split-transfer leg or a cross-owner leg (`conversionLocked`); leaving Transfer mode on an existing leg resets account and signed amount to the row's own, because the form loads the PAIR (source account, source amount) whichever leg opened it.

## Tried and ruled out
- Extending `convertRowToTransfer` (the rule planner's path): it refuses splits, cross-currency and carries no body; the form's conversion needs `prepareTransfer`'s FX and account resolution.
- Reusing `writeTransferLegs` for the conversion: it creates two rows, applies rules and the externalId lookup; a `reuseRowId` option would have threaded through every caller.

## Watch out
- `createExistingTransaction()` in `TransactionForm.test.tsx` has no `linkedTransaction` in its inferred type: a test mutating `linkedTransaction` needs `const tx: any = createTransferTransaction()`.
- `settlePendingHistoryWrites()` before reading `action_history` in an integration spec; `record()` is fire-and-forget.
- In a worktree with no local PostgreSQL, `/tmp/embedded-pg/run-spec.mjs <pattern>` (embedded-postgres, port 54329) runs one integration spec; `npm run test:integration -- <pattern>` runs the whole suite.
