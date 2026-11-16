---
title: Why profile-read trade emails land in AI review instead of auto-booking
author: Ken
date: 2026-10-19
branch: main
---

## Decided
- No LLM is called for a trade email that a saved profile reads. EmailReceiptTradeService parses it deterministically, then reuses the ai_review_requests and confirm-card plumbing so a person can approve it: an `email_trade` request is created already claimed by EMAIL_RECEIPTS_CLAIM_KEY, and submitTrade stores the engine's own proposal on it. The ledger row is only written by /ai/actions/confirm.
- The UI tells the two paths apart with `tradeSource`/`tradeRequestSource`: `profile` means a profile read it, `ai` means the person chose "Recognize as a trade". Use these to tell whether a real AI is involved.
- Nothing has been changed yet. The user has not chosen between a config fix and relaxing the gate.

## Tried and ruled out
- Ruled out that the trade pipeline makes a provider call. Only askAi({asTrade}) with RECEIPT_TRADE_CHAT_INSTRUCTION hands a trade to the assistant or an MCP agent.

## Watch out
- The trade auto-apply gate (email-receipt-trade.service.ts) needs all of: mailbox autoApply on, parser status `approved`, `trade.consistent === true`, and `!ledger.anyMatch`.
- `consistent` is null unless the email states BOTH price and total (parse-trade.ts), and null blocks auto-apply. A broker that prints only the total or only the price therefore always goes to manual review.
- Relaxing the gate for null would lose the quantity-times-price cross-check that catches a misread quantity or ticker.
