---
title: Intraday portfolio chart opened a day late in the evening (UTC today)
author: Ken
date: 2026-10-22
branch: fix/intraday-window-user-today
cost: { minutes: 20, tokens: 151284 }
touches:
  - backend/src/securities/portfolio.service.spec.ts
  - backend/src/securities/portfolio.service.ts
---

## Decided
- The intraday 1W/MTD/1M window in PortfolioService.loadIntradayData is dated by todayYMD() (the request timezone from RequestContextInterceptor), matching the client's usePortfolioRangeWindow and the period-result caption. The intraday cache key carries that day.
- The `today` handed to planOpeningClose/newestSessionClose stays the UTC date of `now`: it is compared against the bars' own UTC dates to tell a live session from a finished one.
- 1D was left alone: it has always opened on the session's first bar by design; adding a prior-close opening point is an open question for Ken (weekend/pre-market: Yahoo's 1d is the last session, so the opening close would be the one before it and the caption would have to follow).

## Tried and ruled out
- The bond commits (isPricedByQuoteProvider gating intraday fetch, per-account bond valuation) were suspected because they touched portfolio.service.ts after the Sept 28 opening-close fix; they do not affect the window.
- Running the service via a Nest application context inside the dev backend container failed on an invalid xx/categories.json from another session's work; not needed once the clock was read.

## Watch out
- Symptom signature: chart's first point is the day AFTER the "Since the close of trading on" date at 16:00, only for 1W/1M, only after 20:00 ET (00:00 UTC). It looks fine during market hours.
- Any backend code that resolves a user-facing calendar day with formatDateYMD(new Date()) is UTC; use todayYMD() inside a request. Bar timestamps, by contrast, are compared in UTC.
