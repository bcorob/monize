---
title: Return of capital basis rule and its exchange-rate trap (issue 1800 review)
author: Node
date: 2026-10-22
branch: claude/issue-1800
cost: { minutes: 1, tokens: 5834 }
touches:
  - "backend/src/securities/investment-replay.util.ts#applyReturnOfCapital"
  - "backend/src/securities/investment-replay.util.ts#returnOfCapitalAmount"
  - backend/src/securities/portfolio-calculation.service.ts
  - backend/src/securities/holdings.service.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/investment-reports/investment-report-data.service.ts
---

## Decided
- Supersedes the touches of the earlier issue-1800 learning (it listed only i18n files); its decisions stand. RETURN_OF_CAPITAL is a base action; the basis rule is applyReturnOfCapital / returnOfCapitalAmount / basisAfterReturnOfCapital in investment-replay.util.ts, folded by computeHoldingsMap, getHoldingAt, the action-history undo rebuild, cost-basis lots, calculateRealizedGains, the capital-gains-by-period replay and the custom investment report.
- RealizedGainEntry carries `action`; the excess of a return of capital over the basis is a row with action RETURN_OF_CAPITAL, quantity 0 and price 0, which RealizedGainsReport labels and leaves shares/price blank.
- QIF RtrnCap rows imported before the change stay DIVIDEND until the user edits the action (no data migration).

## Tried and ruled out
- Passing the loop's `exchangeRate` (computed as `Number(tx.exchangeRate) || 1`) to returnOfCapitalAmount: a stored 0 became par and the null branch was dead code.

## Watch out
- calculateRealizedGains and calculateCapitalGainsForPeriods compute `exchangeRate = Number(tx.exchangeRate) || 1` for SELL proceeds. Anything that must treat a 0 rate as unknown (returnOfCapitalAmount, acquisitionCost) has to be given the raw `tx.exchangeRate`.
- action-history rebuildHoldings is a hand-written copy of computeHoldingsMap and needs its own test for every basis branch.
