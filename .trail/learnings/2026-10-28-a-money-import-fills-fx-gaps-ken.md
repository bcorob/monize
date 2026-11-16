---
title: A Money import fills FX gaps by re-parsing with looked-up rates; the parser stays pure
author: Ken
date: 2026-10-28
branch: fix/mny-money99-user-report
id: l-7ca7fbe1
scope: repo
status: active
src: agent
touches:
  - backend/src/import/mny/mny-market-rates.service.ts
---

## Decided
- `MnyMarketRateService` (backend/src/import/mny/mny-market-rates.service.ts) parses, reads `investments.rateGaps`, looks the rates up, and parses again with `marketRates`, because `MnyParserService.parse` is synchronous and database-free and both the preview and the job must convert through the same code. Rates come from `resolveStoredRate` first, then one `fillRateWindow` per pair spanning every missing date, so a 20-year file costs one provider call per pair.
- A market rate is keyed to the exact trade date and used only when the file's own rate does not resolve, because mixing market observations into the file's lookup let a newer market row outrank a file rate for a later trade.

## Tried and ruled out
- `getRateForDate` per trade: it fetches a 52-day provider window per uncovered date, so 101 sparse trades meant up to 101 outbound calls and Yahoo rate limits.
- `ExchangeRateHistoryService.fillRateGaps`: it fills a currency against the user's default currency, capped at 8 windows and 20 s, but a trade needs the security currency against the account currency, which is a different pair.
- Making the parser async: every caller and spec constructs and calls it synchronously, and `mny:inspect` must stay offline.

## Watch out
- The second parse must pass `alreadyDecrypted: true` and no password, because the first parse decrypted the upload in place and RC4 would re-encrypt it.
