---
title: "Reconcile screen prefill, pre-tick rule and the accounts Last Reconciled column"
author: Node
date: 2026-10-30
branch: claude/issue-1939
cost: { minutes: 28, tokens: 300632 }
touches:
  - frontend/src/i18n/messages/de/accounts.json
  - frontend/src/i18n/messages/es/accounts.json
  - frontend/src/i18n/messages/fr/accounts.json
  - frontend/src/i18n/messages/hi/accounts.json
  - frontend/src/i18n/messages/id/accounts.json
  - frontend/src/i18n/messages/it/accounts.json
  - frontend/src/i18n/messages/ja/accounts.json
  - frontend/src/i18n/messages/ko/accounts.json
  - frontend/src/i18n/messages/nl/accounts.json
  - frontend/src/i18n/messages/pl/accounts.json
---

## Decided
- Statement Ending Balance prefill reuses GET /accounts/daily-balances with startDate=endDate=statement date and accountIds=<id> (one point: opening balance + LEDGER_MOVEMENT_PREDICATE rows on or before the date). No new endpoint. Rounded with roundToCents, because CurrencyInput's notifyIfChanged ignores a typed value equal to roundToCents(held value), so a 4dp prefill would swallow a typed cents figure.
- A ticket ref (balanceTicketRef) guards the prefill: every request and every typed balance bumps it, and a response is adopted only if its ticket is still the newest.
- Pre-tick rule is initialReconcileSelection / carryReconcileSelection in components/reconcile/reconcile-rows.ts: every listed row dated <= statement date, any status. On reload a row that was already listed keeps the user's tick state, and a new row gets the initial rule. The old "re-tick anything CLEARED on reload" behaviour is gone.
- Account.lastReconciledDate comes from AccountsService.findAll: MAX(COALESCE(reconciled_date, transaction_date)) over RECONCILED parent rows. That is the statement date, not the newest reconciled row's date. ReconciliationData.lastReconciledDate (the stale-row classifier) is still MAX(transaction_date); the two are deliberately different.
- The accounts list column reads reconcileLedgerOf(account, logical) (AccountRow.tsx), the same ledger the Reconcile action opens: a pair's cash half, null for a bare brokerage. Joint rows show nothing.

## Tried and ruled out
- An em dash for "no date": AccountRow tests and readers take a dash on this list to mean an unknown total. The cell is blank instead.
- A non-sortable column: AccountList.mobileWrapped.test pins tier header == phone sort buttons + Actions, so a new tier column has to join SORT_FIELD_LABEL_KEYS.

## Watch out
- react-hooks/set-state-in-effect flags an effect calling a component-level useCallback that sets state after an await. Define the async body inside the effect (the loadAccounts pattern) and put the fetch in a module-level pure function.
- react-hooks/refs flags an inline onClick arrow, inside a render helper (renderCompleteStep), that calls a function touching a ref. Hoist it to a named handler.
- The frontend test:changed run here hits AccountBalancesReport.test TODAY mismatches after 20:00 EDT (UTC has rolled over). It passes under TZ=UTC.
