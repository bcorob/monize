---
title: Investments page timeouts on decades of history (issue 1888)
author: Node
date: 2026-10-27
branch: claude/issue-1888
cost: { minutes: 29, tokens: 221902 }
touches:
  - backend/src/common/time-series/rate-index.util.spec.ts
  - docs/frontend/api-and-cache.md
  - frontend/src/lib/constants.ts
  - frontend/src/lib/investments.test.ts
  - frontend/src/lib/investments.ts
  - frontend/src/lib/net-worth.test.ts
  - frontend/src/lib/net-worth.ts
  - backend/src/common/time-series/rate-index.util.ts
---

## Decided
- The Investments page fires several since-inception daily valuations at once: GET /portfolio/summary (getInvestedResultSinceInception -> getPeriodResult(all), fetchMissing:false), /net-worth/investments-period-results (batch includes `all`), and the value chart's /investments-daily + /investments-period-result when its range is long. Each runs NetWorthService.foldDailyInvestments over every calendar day; they serialize on Node's single event loop, so all four time out together.
- Profiled the fold on a synthetic 28y x 60 holdings x 3 currencies dataset: 2.85 s, ~45% in resolveFxRate date math (addDays/daysBetween per lookup), because each holding re-resolves the same pair for the same day. resolveIndexedRate now memoizes per (index object, pair, date) in a WeakMap: 0.95 s, identical output.
- Client: PORTFOLIO_VALUATION_TIMEOUT_MS (120 s, frontend/src/lib/constants.ts) on summary, daily, period-result(s), breakdown.
## Tried and ruled out
- In-flight coalescing of loadDailyInvestments across those requests: biggest remaining win (4 folds -> 2; summary's fetchMissing:false keeps it separate), but it is a new cache needing the portfolio-summary invalidation/broadcast for read-your-writes; proposed, not built.
## Watch out
- Benchmark harness: `npx ts-node --transpile-only -r tsconfig-paths/register` (the @/ alias) and `new NetWorthService({} as any)` then `(svc as any).foldDailyInvestments(...)`. Build a fresh index per run or the memo flatters later runs.
- backend tsc needs NODE_OPTIONS=--max-old-space-size=4096 on this machine or it aborts out of heap.
- The pre-commit hook did not catch a prettier error in a spec; run eslint on changed files before committing.
