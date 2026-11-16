---
title: Adding the RETURN_OF_CAPITAL investment action (issue 1800)
author: Node
date: 2026-10-22
branch: claude/issue-1800
cost: { minutes: 35, tokens: 428031 }
touches:
  - frontend/src/i18n/messages/de/ai.json
  - frontend/src/i18n/messages/de/investments.json
  - frontend/src/i18n/messages/de/layout.json
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/de/scheduledTransactions.json
  - frontend/src/i18n/messages/de/securities.json
  - frontend/src/i18n/messages/es/ai.json
  - frontend/src/i18n/messages/es/investments.json
  - frontend/src/i18n/messages/es/layout.json
  - frontend/src/i18n/messages/es/reports.json
---

## Decided
- RETURN_OF_CAPITAL is a base action of its own, not a refinement in baseInvestmentAction: its cash behaves like DIVIDEND (amount-only, cash destination allowed, embedded splits), but it reduces cost basis and is not income, and a refinement must move everything exactly as its base does.
- Basis rule lives once in investment-replay.util.ts: applyReturnOfCapital (floor at zero, excess is a realized gain on the distribution date), returnOfCapitalAmount (total x rate, null on a bad rate), basisAfterReturnOfCapital (security-currency folds). investedFlowKind is capitalOut; computeInvestmentFlows puts it with sale proceeds; the custom report's period returns count its cash.
- Excess over basis is pushed as a RealizedGainEntry with quantity 0 and the ROC transaction id.
- QIF RtrnCap maps to it (was DIVIDEND). The .mny act code is unknown, so the Money importer does not map it.
- docs/specs/return-of-capital.md is the definition.

## Tried and ruled out
- Making it a DIVIDEND refinement: every income surface keyed on base action would have counted it as dividend income, and investedFlowKind would have called it income.

## Watch out
- investment-replay.guard.spec.ts only looks 25 lines past a SPLIT branch for applyActionToQuantity. Adding a branch AFTER the SPLIT branch in computeHoldingsMap or action-history rebuildHoldings pushes the reducer out of the window; put the new branch BEFORE the SPLIT branch.
- src/mcp/tools-list-budget.spec.ts has per-tool and total byte budgets; a new enum value appears in both investment tools (nativeEnum). Trim descriptions rather than raising the budget. The MCP actions array .max() must equal the enum size.
- Backend test:changed with default workers pulls ~430 related specs; run the same list with --maxWorkers=2 and TZ=UTC (loan-payment-frequency guard fails off UTC).
