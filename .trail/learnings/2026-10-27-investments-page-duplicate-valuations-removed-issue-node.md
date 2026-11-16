---
title: Investments page duplicate valuations removed (issue 1888 review round)
author: Node
date: 2026-10-27
branch: claude/issue-1888
cost: { minutes: 24, tokens: 129151 }
touches:
  - backend/src/common/process-local-state.guard.spec.ts
  - docs/frontend/financial-figures.md
  - frontend/src/hooks/useInvestmentData.test.tsx
  - frontend/src/hooks/useInvestmentData.ts
  - frontend/src/app/investments/page.test.tsx
  - frontend/src/app/investments/page.tsx
  - frontend/src/components/investments/InvestmentValueChart.tsx
  - frontend/src/components/investments/PortfolioPerformanceCard.test.tsx
  - frontend/src/components/investments/PortfolioPerformanceCard.tsx
  - frontend/src/hooks/usePortfolioPeriodResult.test.ts
---

## Decided
- Supersedes the "proposed, not built" part of the earlier issue-1888 learning: the maintainer asked for all three follow-ups, and they are built.
- Backend: `backend/src/net-worth/daily-investments-in-flight.ts` lets identical concurrent `loadDailyInvestments` calls share one promise while it runs. It holds in-flight promises only (dropped on settle, no TTL). The key is the resolved start/end, sorted scope, currency, collectPositions, the fetchMissing opt-out, the identity and the timezone. It is bypassed inside an ambient transaction (`getActiveScopedManager`). `invalidatePortfolioSummary`, `invalidateAllPortfolioSummaries` and `applyPortfolioSummaryInvalidation` drop its entries too.
- Frontend: the Investments page owns the `usePortfolioPeriodResults` batch and passes it to PortfolioPerformanceCard (`periodResults`, the card's own hook gets `skip`) and to InvestmentValueChart, whose `usePortfolioPeriodResult` reads a preset from it (`shared`). It waits while the batch loads and asks for itself on error, a missing window, a currency mismatch or a dated range (mtd/custom).
- useInvestmentData's automatic price refresh waits for the first summary to settle (`initialSummarySettled`), not only for the transactions.
## Tried and ruled out
- Sharing the summary's fetchMissing:false walk with fill-enabled callers: it would make the summary wait on provider fills (#1409). The keys stay separate.
## Watch out
- `process-local-state.guard.spec.ts` fails on any new class-scope Map. The in-flight map has an allowlist entry with its reason, next to `portfolio-summary-memo.ts#entries`.
- page.test.tsx mocks the card and the chart, so it has to mock `@/hooks/usePortfolioPeriodResults` now that the page calls it.
