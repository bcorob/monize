---
title: Dividends and reinvestments in email trade profiles
author: Ken
date: 2026-10-19
branch: feat/email-receipt-dividend-trades
cost: { minutes: 1, tokens: 40841 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided
- Trade profiles read four actions: BUY, SELL, DIVIDEND (cash), REINVEST (DRIP, one REINVEST row; the ledger already counts it as dividend income plus an acquisition). Reinvest words win over dividend words, which win over buy/sell.
- trade.quantity is optional in the profile; BUY/SELL/REINVEST still need it at read time (trade_no_quantity). DIVIDEND needs a total, or price plus quantity.
- The maintainer chose: a complete cash dividend may auto-apply with consistent null (tradeMayAutoApply in parse-trade.ts). consistent false never auto-applies.
- One action mapping lives in backend/src/ai-review/trade-action.ts (tradeInvestmentAction, tradeActionOf, tradeMatchesOnQuantity).
- Spec: docs/specs/email-receipt-dividend-trades.md.

## Tried and ruled out
- Matching a dividend duplicate on quantity: create() stores quantity 0 for a dividend without shares, so findTradeInLedger compares total_amount for DIVIDEND instead.

## Watch out
- Fixed AI-review instruction texts are keyed by exact text (receiptInstructionKey) and email-receipts.service tells ai vs profile trade requests apart by `rq.instruction` text. Rewording one needs the old text kept as an alias (RECEIPT_TRADE_CHAT_INSTRUCTIONS).
- Several places used `x === "BUY" ? BUY : SELL` or "not SELL means BUY" fallbacks; a new action is silently mislabelled there rather than refused. Grep for them when adding another action.
- Global npx prettier (3.8.1) differs from the repo's (3.9.10); use backend/node_modules/.bin/prettier.
