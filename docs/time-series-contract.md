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
