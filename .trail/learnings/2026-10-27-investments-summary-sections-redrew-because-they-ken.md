---
title: "Investments summary sections redrew because they gated on the register's isLoading and hasLoadedRef was never set by the first load"
author: Ken
date: 2026-10-27
branch: main
id: l-1a23c70c
scope: repo
status: active
src: agent
touches:
  - docs/frontend/financial-figures.md
  - frontend/src/app/investments/page.tsx
  - frontend/src/hooks/useInvestmentData.test.tsx
  - frontend/src/hooks/useInvestmentData.ts
  - frontend/src/hooks/usePortfolioPeriodResults.test.ts
  - frontend/src/hooks/usePortfolioPeriodResults.ts
  - docs/frontend/api-and-cache.md
---

## Decided
- Summary card, allocation and holdings on /investments gate on `isSummaryLoading` (= !initialSummarySettled) from `frontend/src/hooks/useInvestmentData.ts`; only the brokerage register uses `isLoading`. The register answers ~0.2 s, the summary ~1.5-2 s, so gating on `isLoading` showed "no data" in between.
- `loadAllPortfolioData` no longer touches `isLoading`. The old `hasLoadedRef` was set only inside `loadAllPortfolioData`, so its FIRST call (the auto price refresh, ~2.8 s after open) flipped every section back to skeletons. It now also settles `initialSummarySettled` when its request supersedes the first summary's, or the skeleton would never end.
- `usePortfolioPeriodResults` keeps the previous answer through a same-scope reload (reloadKey bump only); a different scope or a failed reload never shows stale figures. Before, "Portfolio performance" collapsed to fewer rows plus a Loading notice on every reload.
- `onRefreshComplete` returns the reload promise so RefreshPricesButton spins until the summary is re-valued (the "stale is marked" rule in docs/frontend/api-and-cache.md).
## Tried and ruled out
- Trusting the existing "keeps isLoading=false on subsequent reloads" test: it asserts only after the reload settles, so it passed while skeletons showed mid-flight. New tests hold the request open and assert during it.
## Watch out
- Diagnose this page from a HAR: the second burst of summary/period-results/intraday right after POST /securities/prices/refresh/selected is the price-refresh reload; any skeleton during it is a loading flag being set by a background path.
