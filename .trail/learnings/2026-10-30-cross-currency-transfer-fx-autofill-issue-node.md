---
title: Cross-currency transfer FX autofill (issue 1936)
author: Node
date: 2026-10-30
branch: claude/issue-1936
cost: { minutes: 12, tokens: 117054 }
touches:
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
  - frontend/src/i18n/messages/fr/transactions.json
  - frontend/src/i18n/messages/hi/transactions.json
  - frontend/src/i18n/messages/id/transactions.json
  - frontend/src/i18n/messages/it/transactions.json
  - frontend/src/i18n/messages/ja/transactions.json
  - frontend/src/i18n/messages/ko/transactions.json
  - frontend/src/i18n/messages/nl/transactions.json
  - frontend/src/i18n/messages/pl/transactions.json
---

## Decided
- Autofill lives in frontend/src/components/transactions/useTransferFxAutofill.ts, wired from TransactionForm into TransferTransactionFields via optional onTransferAmountChange / onTransferTargetAmountChange props.
- A side is written only while empty or still auto-filled (refs track which side the hook filled); a typed side is never re-priced. CurrencyInput fires onChange per keystroke, so the "auto" flag is what lets the next keystroke keep re-deriving.
- Rate is getRateForDate(from, to, date) (from * rate = to), stored with its pair:date key; no FX fee applied.
## Tried and ruled out
- A useEffect on `rate` that fills fields: violates the no-setState-in-effect rule; the fill runs in the fetch's .then instead.
- Passing the hook handler as setTransferTargetAmount: the To-account change calls it with undefined and would clear an auto-filled amount.
## Watch out
- Hook tests must import renderHook from @/test/render (intl-harness.guard).
- en-US/en-GB are sparse override catalogs; do not add keys there.
