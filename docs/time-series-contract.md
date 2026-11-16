# Time-Series and Backtest Contract

The canonical rules for any code that works with historical prices, period
returns, or backtests. `docs/financial-calculation-contract.md` defines how
missing values propagate through a point-in-time calculation; this document
defines what "missing" means along the time dimension, and what a calculation
over incomplete history is allowed to claim.

The core principle: **a missing price is missing data, not a price of zero
and not "no change".** Treating a gap in price history as a 0% return is a
specific and usually false financial assumption dressed up as neutral
handling.

## 1. Adjusted versus raw prices

- Return, performance, and backtest calculations use **adjusted** prices
  (adjusted for splits and, where available, distributions), so that a split
  does not appear as a crash and a dividend is not lost from the return.
- Position valuation ("what is this holding worth today") uses the raw close
  and the actual share quantity held.
- A single calculation must never mix adjusted and raw prices for the same
  instrument. State which series a function consumes in its contract.
- **Choose the basis per series, never per row.** An adjusted-close column is
  typically nullable and typically written by one source only, so a per-row
  `COALESCE(adjusted, raw)` reads like "adjusted, falling back where the
  provider gave none" and is in fact a splice: every row some other writer
  inserted -- a transaction-derived price, an import, a seed -- lands raw
  inside an adjusted history. Around a split that is a several-hundred-percent
  return and a drawdown that never happened, on any instrument the user has
  ever traded. Decide once per instrument over the window being read: adjusted
  rows only where any exist, raw throughout where none do, never both.

### 1.1 A quote is provisional; a daily bar is the day

A live quote and a daily bar answer different questions, and only one of them
is what a daily price series holds. `regularMarketPrice` is the last print at
the instant it was asked for -- true about that instant, and false about the
day: it is not the close, its volume is a running total, and its high and low
are only the extremes reached so far. The provider's daily bar is the finished
session, and it is the only thing carrying an **adjusted** close at all.

So a row written from a quote during the session is *provisional*, and the
closing job's obligation is to come back for the bar once the session has
ended. Two rules follow, and both were broken at once:

- **Never let "a price exists for today" stand in for "the day is settled".**
  The closing refresh skipped any security already carrying a provider-written
  row for the day, which is exactly what an intraday refresh leaves behind --
  so the stored close was whichever mid-session quote happened to be last, on
  every day the user had the app open. The predicate is whether the *session*
  has ended (`isSessionSettled`, evaluated on the market's own clock in the
  market's own zone), not whether a row is present.
- **A column only one writer populates is a column that is usually empty.**
  `adjusted_close` was written by the historical backfill and by nothing else,
  and the backfill runs on demand -- so every row the daily job wrote left it
  null. Combined with the per-series basis rule above, that is worse than a
  gap: `bool_or(adjusted_close IS NOT NULL)` is true because the backfilled
  rows have it, so the unadjusted rows are *dropped*, and a series silently
  ends at the last backfill instead of at the last trading day. A column a
  calculation depends on needs a writer on the recurring path, not only on the
  manual one.

The newest session is the one case where a writer with no adjusted close of
its own may still supply one: **the adjustment factor of the latest bar is 1**,
because nothing has gone ex after it, which is why a provider reports its last
bar's adjusted close as equal to its close. So the quote path fills
`adjusted_close` with the close it is already writing, and today is in the
series from the first intraday refresh rather than from the evening's
settlement. Two conditions on that, both enforced in the statement rather than
by convention:

- **Only where the series already carries an adjusted close.** Completing a
  basis is not the same as changing one. A provider that supplies none (MSN)
  leaves a series raw throughout, which is consistent and complete; one
  inferred adjusted row flips `bool_or(...)` and collapses that entire series
  to that single row -- a worse failure than the gap being fixed.
- **Only for the session the quote is for.** The inference is about the newest
  bar and nothing else. A price for an arbitrary past date -- a manual entry, a
  transaction-derived price -- has an adjustment factor we do not know, and
  must not pretend to. Such a row stays out of the adjusted series, which is
  the correct answer to "what was this worth, adjusted?" when nobody knows.

### 1.2 A coarser series is not a sparser one

A provider asked for a long range may answer with weekly or monthly bars. Stored
into a daily table they are indistinguishable from daily rows, and they
overwrite whatever real daily rows sat on those dates -- so a payload nobody
checked corrupts more than it adds. **Check the median spacing of every provider
payload before storing it, and refuse one coarser than daily** rather than
storing it as though it were daily (`assertDailySeries`; the median, not the
mean, so one long exchange closure does not disqualify a daily series).

This compounds with the basis rule above in a way worth stating plainly, because
it is how the defect stayed invisible: the monthly rows arrived *with* adjusted
closes and the daily rows around them had none, so `bool_or(...)` was true and
the adjusted-only filter kept the twelve monthly points and discarded the ~250
daily ones. The window did not look empty or wrong -- it looked like a monthly
series, which is a perfectly plausible thing for a chart to be showing.

## 2. Quote age and period boundaries

- A price used to value a period boundary (period start, period end, or
  "now") must be dated **within a bounded window** of that boundary. The
  window is a deliberate, documented constant of the calculation that uses it
  -- generous enough to span weekends and market holidays, tight enough that
  the quote still describes the boundary (for daily series, days, not
  months).
- An arbitrarily old quote must never be carried forward and treated as a
  current period-end value. The most recent price is not "the price" once it
  falls outside the window -- it is a stale price, and the boundary value is
  unknown.
- A period whose boundary has no price inside the window has an **unknown**
  boundary value, and every metric derived from it (that period's return, and
  any aggregate including that period) follows the missing-data rules below.

### 2.1 One door, not one constant

A named window constant is not enough on its own. Turning a stored observation
into a value-for-a-date must go through a **shared helper that applies the
window**, and every site that needs such a value must use it -- the chart, the
position valuation, the backfill check, the signal, all of them. Adding a
second unbounded path beside the bounded one is how the rule ends up with a
constant, a docstring, and three call sites that ignore both.

In practice that bans, outside the helper itself:

- a nearest-observation lookup with no age test;
- `ORDER BY <date column> DESC LIMIT 1` (or `DISTINCT ON`) with no lower bound
  on the date;
- reading a stored rate or price "latest" and using it in a reported figure.

Where a module has such a helper, a scanning test should fail on a new call
site that bypasses it, in the manner of
`frontend/src/test/ui-conventions.test.ts`.
`backend/src/common/time-series/price-boundary.one-door.spec.ts` is that test.

### 2.2 A series read may fill its own gaps, once, before it reports them

A pair missing from the stored history is usually a fact about what has been
fetched, not about the world: the daily refresh writes today only and
`backfillHistoricalRates` skips a pair the moment it holds any row, so a chart
over a span nobody ever loaded names every point incomplete for rates the
provider has had all along. A series read may therefore ask for them, under
five conditions that are not negotiable, and only these:

- **Demand-driven.** The plan comes from the points that actually failed to
  convert -- the same `missingRatePairs` the response reports -- so a currency
  the window never had to convert costs no provider call.
- **Month-granular and deduplicated.** One `ensureRatesForDate` call fetches
  the whole calendar month around a date, for the pair in either direction, so
  the unit is `(month, directionless pair)`: a 400-point chart costs one call per
  month per pair, not four hundred. The pair is *stored* in one orientation
  (INV-FX-003) and read in either, so the fetch unit and the storage unit are the
  same pair.
- **Bounded.** `MAX_FILL_MONTHS` (24) months per request, newest first. A wider
  range fills the newest two years and reports the rest as still missing; one
  HTTP request must not become an unbounded number of outbound ones.
- **Re-read, never patched.** Only a fill that persisted something triggers a
  rebuild of the rate index **from the database** and a recomputation through
  the same code, so the series converts with what a second request would find.
- **Best-effort, and it never invents a rate.** A provider that is down or has
  no history for a pair leaves the point exactly where section 3 leaves it: the
  pair named, the figure withheld. The read never fails because an outbound
  fetch did, and a caller that must not reach the network at all (a cron, an
  LLM tool) passes `fetchMissing: false`.

`backend/src/net-worth/series-rate-fill.ts` is the shared planner and runner,
used by the investment series, the investment breakdown, the monthly net-worth
series and `PortfolioPeriodResultService`;
`backend/src/accounts/account-balances-report.service.ts` is the same shape for
a point-in-time report (`docs/specs/account-balances-as-of.md` section 7.1).

One deliberate exception lives **inside** the door rather than beside it:
`backend/src/common/time-series/nearest-observation.ts` answers "what is the
closest thing anybody ever observed", unbounded, for a surface that has decided
an approximation beats refusing the figure (the Account Balances report --
`docs/specs/account-balances-as-of.md` sections 4.2 and 7.2). It is not a
value-for-a-date and must never be used as one, which is why it returns the
observation's **date** alongside its value and why every consumer has to carry
that date through to the user. The bound above is what tells such a caller the
date has no price in the first place; the substitution is explicit, marked, and
after the fact.

A second deliberate exception is **point-in-time position valuation**, and it
is a different question from a period boundary. A holding you still own is worth
its latest accepted close carried forward until a newer one supersedes it, with
no age bound: a private security, a manually priced holding or an untraded fund
may not have a fresh close for months, and refusing to value it after two weeks
would report a position the user plainly holds as unknown. So
`backend/src/net-worth/position-price.util.ts` (`positionCloseAsOf`) uses the
unbounded `pointAsOf`/`priceAsOf`, not `closeAt`, deliberately -- issue #1242,
where valuing a manually corrected 401(k) at anything other than its latest
accepted close is the bug. This does **not** license carrying a stale price into
a *return* or period-boundary figure (§2, §2.3 still bind those); it is confined
to "what is this position worth on this date", which reads raw `close_price` and
never `adjusted_close`. Do not "simplify" `positionCloseAsOf` back onto `closeAt`
-- that reintroduces #1242.

### 2.2 An exchange rate is a price

Everything above applies to currency conversion unchanged. A total built from
a fresh price and a nine-month-old rate is no more knowable than one built
from a stale price, and it fails more quietly, because no figure on the page
is denominated in a rate. A conversion feeding a number the user acts on takes
a bounded rate or returns unknown.

The door is `resolveFxRate`
(`backend/src/common/time-series/fx-rate-resolver.ts`): the newest observation
on or before the date, in either stored direction, within
`FX_MAX_RATE_AGE_DAYS`, never one from after the date, and `null` with a named
reason otherwise -- `backend/src/common/time-series/fx-rate.one-door.spec.ts`
fails a newest-rate read that bypasses it.

**The answer must not cost the size of the history.** The door prepares each
direction's observations once -- the rows with a usable rate and a date, sorted
ascending, memoized against the array the caller handed over -- and then finds
the admissible one by binary search. It used to read every row on every call,
two `Date.parse` calls apiece: a since-inception portfolio walk asks for a rate
on each of ~9,700 days against an index holding ~9,700 rows per direction, so
one pair alone blocked the event loop for 66 seconds -- long enough for the
readiness probe to fail and the pod to leave the Service (issue #1409). Which
observation is chosen is the policy above and may be argued with; reading all of
them to find it is not part of it.

The periodic capital-gains report (`calculateCapitalGains`) is bound by this:
it values each period boundary at the FX accepted for that boundary's own date
in historical mode -- the start at `priceLookupStart`, the end at `periodEnd` --
never once at today's live rate for both ends, which read a currency's move over
the window as none.

### 2.3 A boundary needs two observations, not two lookups

When a span's two ends are bounded independently, both can resolve to the
*same* observation -- necessarily so whenever the span is shorter than the
window. The arithmetic then returns exactly zero change, which is
indistinguishable from a market that went nowhere and counts itself as a fully
covered period. Require the two ends to be **different observations**, and
distinguish the two reasons a span has none: a gap in the history, versus a
period that has not yet produced a second close. They are answered differently
-- the first breaks the chain, the second has simply not happened yet.

### 2.4 Two boundaries say nothing about the interior

A metric that depends on the *path* between boundaries -- drawdown, intraperiod
extremes, anything "worst" or "peak" -- is only measurable where the
observations between them are actually consecutive. Boundaries that satisfy
the window rule are no evidence about the middle: a month-long hole is stepped
straight over, and the walk reports a calm zero for a period that may have
halved. Check the spacing of the observations inside the span, and return
`null` when any stride exceeds the window.

### 2.5 An open-ended window starts at the data, not at an epoch

"All time" is a request with no start date, and the answer to "when does the
data start" is a query, not a constant. Resolve it from the scope the request
actually names -- the earliest transaction, holding or observation across those
accounts, falling back to when the account was created -- and use the same rule
the stored series used to decide where it begins, so two views of the same
scope open on the same point instead of years apart.

A hardcoded fallback (`startDate || "1990-01-01"`) is safe only where stored
rows bound the result: an over-wide window selects nothing extra from a table
that already starts at inception. It is wrong wherever the series **enumerates
its own sample points** from the window, because every sample between the epoch
and the first real datum is materialized as an empty point. That is what
issue #1081 reported: the per-security portfolio chart opened in 1990 and
flattened three decades of nothing against the x-axis. `net-worth.service.ts`
carries the allowlist and the scan test that holds it.

### 2.6 A sample date is a calendar date, not an instant

A series keyed by calendar date enumerates `YYYY-MM-DD` strings and steps them
with `addDaysYMD` (`backend/src/common/date-utils.ts`) or, for a whole window,
`enumerateDaysYMD` (`backend/src/net-worth/series-dates.util.ts`). A `Date` built
from a date string plus `T00:00:00` is LOCAL midnight, and `toISOString()` reads
UTC components: the pair names every day one day early in any process east of
Greenwich, and drops the last day of the window entirely. The database returns
real calendar dates, so the keys stop matching and every lookup against them
falls to its default.

That default is the second half of the rule. A series point looks up its
components by date; when a component the query was asked to produce has no row
for that date, the point is missing data, not holding zero. Walk the EXPECTED
components -- the resolved account scope, not the maps the query happened to
return -- so a missing map is visible, and give the gap a completeness flag of
its own (`cashComplete` and `unknownCashAccountIds` on
`DailyInvestmentValue`) rather than a `?? 0` that reads as a measurement. Zero is
the right answer only where the query legitimately says "no movement" and the
opening balance is already carried; a row that was never produced says nothing
at all. `series-dates.guard.spec.ts` scans `backend/src/net-worth/` for both
shapes.

### 2.7 A coarser chart samples the fine series and keeps its boundaries

A chart drawn at a coarser resolution than the figures beside it -- a
long-range portfolio chart at one point a month -- is the fine series
**sampled**, not a second series. Its points are days of the same daily
valuation (the same replay, the same accepted close, the same rate index and the
same completeness flags), taken on the window's first day, each month-end
strictly inside it, and its last day (`monthEndSampleDates`,
`backend/src/net-worth/series-dates.util.ts`).

Two rules follow, and each closes a way the chart and its figures disagreed:

- **The boundaries are the window's, not the buckets'.** The first point is the
  close the period figures are measured from and the last is the one they are
  measured to, so the figure captioned as the chart's change IS its last point
  less its first. A series of stored month-end snapshots opens on the end of the
  starting month instead -- up to a month after the period does, holding
  whatever happened in between -- and its first bucket can be a cost-basis
  stand-in rather than a value at all.
- **Nothing is spliced.** Prepending one daily point to a stored monthly series
  puts two valuation paths into one line, which is the sampling splice section
  1.2 exists to stop. Sample the daily fold instead; the stored snapshots stay
  what the net-worth report reads.

The portfolio routes that take `sampling: 'monthEnd'` (`investments-daily`) and
`granularity: 'monthEnd'` (`investments-breakdown`) implement this; an
open-ended ("all time") sample opens where the period result's `all` window
does, the day before the scope's first investment transaction
(`loadFirstInvestmentDate`). INV-PORTCHART-001.

## 3. Missing returns are never zero

- A period with no usable prices has `return: null`. Never `0`.
- A gap must not be bridged by assuming the portfolio value was flat across
  it. If the value at the start or end of a period is unknown, the period
  return is unknown.
- Interpolation across a gap is only acceptable when the calculation
  explicitly documents it, the interpolated span is flagged in the output,
  and the affected periods are identified -- never silently.
- **The rule survives to the pixel.** A `null` the server took care to produce
  is undone by a chart that bridges it (`connectNulls` and its equivalents),
  by a bar rendered at zero width beside an unknown label, or by a row that
  vanishes instead of showing an unknown marker. A straight segment across
  four unobserved months is indistinguishable from measured data, and a
  tooltip admitting "unknown" under the cursor does not undo it. Whoever adds
  the `null` owns its rendering.
- **A withheld figure names its cause where it is withheld.** The gap says
  that something is unknown; it does not say what to repair. The surface that
  withholds carries the causes the series already dates -- which instrument,
  which currency pair, which account, over which dates -- close enough to the
  withheld figure to be read with it, and resolved to names rather than ids.
  `foldIncompleteData` and `IncompleteDataDetails`
  (`frontend/src/lib/incomplete-data-ranges.ts`,
  `frontend/src/components/reports/IncompleteDataDetails.tsx`) are that
  rendering for the portfolio series.

## 4. Incomplete history: reject or disclose

A backtest or performance calculation whose price coverage is incomplete must
either be **rejected** or returned with an explicit incomplete state -- never
returned as if complete:

```typescript
status: 'complete' | 'incomplete';
missingPeriods?: string[];   // which periods lacked usable prices
```

- Affected metrics are `null`, not computed over the covered subset and
  presented as if they described the whole span.
- Aggregate metrics that a gap invalidates -- CAGR, cumulative return,
  volatility, drawdown, Sharpe-style ratios -- become `null` when any period
  they span is missing, because each assumes an unbroken chain of returns. A
  "normal-looking" CAGR over a history with holes is a fabricated number.
- Metrics that can be honestly restricted (e.g. best/worst *covered* period)
  may be returned, labelled as covering only the known periods.
- The instruments and date ranges responsible for the gaps must be
  identifiable from the response, so the consumer can fix the data instead of
  distrusting the feature.

**Fetch before you disclose.** A gap the provider can close is fetched on the
read path before it is reported: the series names the months and pairs it is
short of, asks once per unit within a fixed cap, re-reads the store, and only
then folds what is still missing into `missingPeriods` / `missingRatePairs`.
The fetch is best-effort and never invents: a provider outage leaves the gap
named and the request successful, a pair the provider does not carry stays a
gap, and a caller that must not reach the network (a cron, an LLM tool, an
export) opts out and reads the store as it is. What is then disclosed obeys
`docs/financial-calculation-contract.md` section 1.3: the thing missing, by
name, and the way to obtain it.

## 5. Signal and simulation coherence

For strategies that materialize periodic signals and simulate acting on them:

- A simulation may only chain periods whose signals were produced under the
  same configuration revision (see the materialized-results rule in
  `docs/financial-calculation-contract.md`); a predecessor chain that crosses
  a configuration change is broken, not continuous.
- Calendar rules (which dates count as period boundaries, how non-trading
  days shift them) are part of the declared configuration -- changing them is
  a configuration change.

## 6. Testing

Time-series code inherits the testing requirements of
`docs/financial-calculation-contract.md` section 8, and draw inputs from
`docs/testing-contract.md`. The adversarial cases
specific to this contract: a gap in the middle of a backtest, a stale quote
just outside the boundary window, a first period with no starting price, and
an instrument whose history starts after the requested range -- each must
produce `null`/`incomplete`, and a test must fail if it produces a number.
