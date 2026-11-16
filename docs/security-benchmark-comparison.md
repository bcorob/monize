# Security Performance Comparison and Benchmark Overlay

The contract for the Security Performance report's comparison chart: what a
plotted line claims, when a series is refused, and what the payload must say
about what it could not work out.

This document is the specification required by
`docs/financial-calculation-contract.md` section 9. It governs
`backend/src/securities/performance-comparison.service.ts` and the chart that
renders its output. It inherits, and does not restate,
`docs/time-series-contract.md` (the time dimension) and
`docs/financial-calculation-contract.md` (what a calculation may claim).

## 1. What the chart answers

> Over the window I chose, how did each of these instruments move, relative to
> where each of them started?

Every series is a **cumulative percentage return**, rebased to zero at the
window's start. Rebasing is what lets instruments with different price levels
and different currencies share one axis.

Two kinds of series are plotted:

- a **security** the user holds or tracks (`securities` row, user-owned);
- a **market index** from the fixed catalog in
  `backend/src/securities/market-indexes.ts`, whose history lives in the global
  `market_index_prices` table.

They are computed identically. An index is not privileged, and nothing about a
user's position enters the arithmetic: this chart is about instruments, not
holdings. Quantity, cost basis and realized result are the stats cards' job and
are unaffected by the window.

## 2. Non-goals, stated so they are not read in

- **No currency conversion.** Each return is computed from that instrument's own
  listing-currency closes. A percentage is not converted, and converting the
  underlying closes at today's rate would answer a different question from the
  one the line is labelled with. `PerformanceSeriesRef.currencyCode` carries the
  currency so the UI can say which one each line is measured in. This mirrors the
  choice `GemPerformanceView` documents in `backend/src/strategies/gem-report.types.ts`.
- **No money.** Nothing here computes, aggregates or reports an amount, so the
  rounding rules in `AGENTS.md` apply only to the percentage
  (`GEM_PP_DECIMALS`, 4).
- **Nothing is materialized.** The endpoint is a pure read, so the
  materialized-result versioning rule (financial contract section 5) and the
  concurrency rules (section 7) are N/A. There is no fingerprint to store and no
  command to reject.
- **No position performance.** "What did my holding return" is a different
  calculation with a different missing-data policy (it needs cost basis and
  settlement currency), and it is not this.

## 3. Invariants

1. **One basis per series, decided over the window being read.** A series is the
   adjusted closes where any row in the window carries one, and the quoted closes
   where none does — never a per-row fallback between them. Rule 1 of
   `docs/time-series-contract.md`, implemented once in
   `backend/src/common/time-series/price-series.util.ts` and reported per series
   as `basis: "ADJUSTED" | "RAW"`.
2. **Every boundary lookup is bounded.** A close stands for the window's start
   only when it was struck within `BOUNDARY_LAG_DAYS` of it, through the single
   helper `closeAt` in
   `backend/src/common/time-series/price-boundary.util.ts`. There is no second
   path to a value-for-a-date.
3. **A series is rebased at the window start, or it is not drawn.** No series
   rebases at its own later first observation. See section 4.
4. **A carried-forward close expires.** Between observations a series holds its
   last close, so a market holiday in one country does not punch a hole in
   another's line — but only while that close is recent enough to speak for the
   date. Past that it is `null`, not a flat line.
5. **Unknown is `null`, never `0`.** At every layer, including the pixels: the
   chart draws no segment across a `null` (`connectNulls={false}`), and no
   series is drawn at 0% because its data was missing.
6. **A refusal is stated, not implied.** A series that cannot be drawn appears in
   `excluded` with a reason. A series that vanishes without explanation is the
   failure this list exists to prevent.

## 4. Exclusion truth table

Let `W` be the requested window `[start, end]`, and `S` an instrument's series
within `W` (loaded with `BOUNDARY_LAG_DAYS` of lead, so the close that prices
`start` is available to the lookup).

| Situation | Result |
| --- | --- |
| `S` has no rows at all in the loaded range | excluded, `NO_PRICE_HISTORY` |
| `S` has rows, but none within `BOUNDARY_LAG_DAYS` at or before `W.start` | excluded, `NO_PRICE_AT_WINDOW_START` |
| The base close resolved at `W.start` is `0` or negative | excluded, `NON_POSITIVE_BASE` |
| The base close is the only observation in `W` | excluded, `SINGLE_OBSERVATION` |
| Base resolved, later observations exist | included; every plotted date is `(close / base - 1) * 100` |
| A plotted date has no close within the carry-forward bound | that point is `null`; the span is listed in `gaps`; `status` becomes `incomplete` |
| `S`'s last observation is before `W.end` | the trailing points are `null` and `totals[key]` is `null` |
| No series at all survives | `series: []`, every candidate in `excluded`, `status: "incomplete"` |

`SINGLE_OBSERVATION` is not a nicety. `closeAt` bounds each end
independently, so a window shorter than the lag can resolve its start and its
end to the same row: the arithmetic then returns exactly `0%`, which is
indistinguishable from an instrument that went nowhere and counts itself as
fully covered. `docs/time-series-contract.md` section 2.3 is the rule; this row
is where it is closed for this calculation.

`status` is `"complete"` only when nothing was excluded, no plotted point is
`null`, and every included series reaches `W.end`.

## 5. Worked examples

Throughout: `BOUNDARY_LAG_DAYS = 14`, window `2025-01-01 .. 2025-12-31`.

**5.1 — ordinary.** A security closes 100.00 on 2024-12-30 and 125.00 on
2025-12-30. The base is the 2024-12-30 close (2 days before the boundary, inside
the window), so the final point is `(125 / 100 - 1) * 100 = 25.0000`, and
`totals` is `25.0000`.

**5.2 — stale base.** The same security's last close before the boundary is
2024-12-15 (17 days). No close stands for `W.start`, so the series is excluded
with `NO_PRICE_AT_WINDOW_START`. It is **not** rebased on its first 2025
observation: doing so would report the year's return measured from March, under
a label that says January.

**5.3 — the splice this design refuses.** A security has provider rows carrying
`adjusted_close` throughout, plus one transaction-derived row from a purchase,
which carries a quoted `close_price` and a null `adjusted_close`. Around a
4-for-1 split the quoted close is roughly four times the adjusted one. A per-row
`COALESCE(adjusted_close, close_price)` therefore splices a ~+300% spike and a
~-75% drawdown into a series where neither happened. The basis is instead chosen
once for the whole series: because some row carries an adjusted close, the series
is the adjusted rows only, and the transaction-derived row is left out rather
than converted. `basis` reports `"ADJUSTED"`.

**5.4 — a feed that stopped.** An index's last stored close is 2025-03-31 and
the carry-forward bound for daily sampling is 10 days. Points up to 2025-04-10
carry the March close; from 2025-04-11 the series is `null`, the span
`2025-04-11 .. 2025-12-31` is listed in `gaps`, `totals` for that key is `null`,
and `status` is `incomplete`. The series is up 8% *to March* and unknown since,
and the second half of that sentence is the half that matters.

**5.5 — an open-ended window.** `all` sends no `startDate`, and the start is
resolved from the data rather than from a constant: a hardcoded epoch would
materialize a sample point for every empty period between it and the first real
datum, which is the defect `docs/time-series-contract.md` section 2.5 records
against the per-security portfolio chart.

**The securities set that boundary; the benchmarks follow it.** An index carries
decades the user has no part in -- the S&P 500 reaches back to 1927 -- so
resolving the start across the whole selection opened "all time" there, every
security failed the boundary test, and the chart drew the benchmark alone. Per
security the start is the **later** of its first stored close and its first
transaction: the close because a window opening before the instrument can be
priced excludes the very thing it was derived from, the transaction because
prices are backfilled further back than a holding goes and years before the user
owned anything are not their performance. A watch-list security with no
transactions has only the first bound. Across several securities the window opens
at the **latest** of those starts, so every one of them is priceable at the
boundary and the comparison is like for like.

With no securities selected the index is the subject rather than the yardstick,
and its own earliest observation is the answer.

This applies to the open-ended case only. A named range means what it says: on a
5Y window a security with two years of history is excluded with its reason, not
quietly given a shorter chart than the one it asked for.

## 6. Missing-data policy summary

| Question | Answer |
| --- | --- |
| An instrument we cannot price at the window start | excluded with a reason; never a 0% line |
| A hole inside an included series | `null` points, a `gaps` entry, `status: "incomplete"` |
| An instrument with no history at all | excluded, `NO_PRICE_HISTORY` |
| An index whose backfill failed | excluded like any other unpriced instrument; the failure is not a return of zero |
| A window in which nothing can be priced | empty `series`, populated `excluded`, `incomplete` |
| A known-flat instrument | `0%` — a genuine zero, which is why unknown may never use it |

## 7. Test matrix

`docs/testing-contract.md` names the input classes; these are the ones this
calculation can actually receive. The rest are recorded as N/A below so a reader
can tell "considered and irrelevant" from "not considered".

| Case | Required result |
| --- | --- |
| Gap mid-series | `null` points, `gaps` entry, `incomplete` — never a bridged line |
| Last close 15 days before `W.start` | excluded, `NO_PRICE_AT_WINDOW_START` |
| Last close exactly 14 days before `W.start` | included, rebased on it |
| History starts after `W.start` | excluded — a series rebased on its own later start is the defect this replaces |
| Window shorter than the lag; both ends resolve to one row | excluded, `SINGLE_OBSERVATION`; never a hard `0%` |
| Base close `0` or negative | excluded, `NON_POSITIVE_BASE`; never `Infinity` or `NaN` |
| Adjusted rows plus a transaction-derived raw row | adjusted only, `basis: "ADJUSTED"` (example 5.3) |
| No adjusted rows anywhere in the window | raw throughout, `basis: "RAW"` |
| Index and security on different market calendars | each carried forward within bound; neither punches a hole in the other |
| `all` range, security plus a benchmark with far deeper history | window opens on the security's activity; both are drawn, neither excluded |
| `all` range, security whose prices start after its first transaction | window opens where it can first be priced |
| `all` range, security whose prices start before its first transaction | window opens at the first transaction |
| `all` range, two securities starting years apart | window opens at the later start, so both are drawn |
| `all` range, benchmarks only | start from the index's own earliest observation |
| Named range (5Y) with a benchmark reaching further back | the window is unchanged; coverage is answered by exclusions |
| `2024-02-29`, `2025-01-31`, `2025-12-31` as boundaries | resolve without off-by-one |
| A `securityId` owned by another user | `404`; nothing about it in the payload |
| Empty selection, unknown index code, 21 security ids | rejected by the real validation pipeline, not by the service |

Recorded as N/A: money precision and half-rounding boundaries (no money is
computed); currency conversion (section 2); concurrency and rejection atomicity
(the endpoint is a pure read that writes nothing); materialization and
configuration fingerprints (nothing is persisted).

Per `docs/financial-calculation-contract.md` section 8.2, each invariant above is
broken on purpose once before its test is trusted, and the change description
records which test fails on which input.

## 8. Timeframe

The window is chosen with the shared `DateRangeSelector` / `useDateRange` pair
and the preset keys `resolveRangePreset` already knows
(`frontend/src/lib/date-range.ts`), persisted per user in localStorage.

**The window governs the chart only.** The stats cards report the position as it
stands now — quantity, cost basis, market value, realized result — and the trade
and dividend tables are history records. Scoping either to a window would make
them answer a question nobody asked: a "cost basis over the last month" is not a
cost basis. The UI says so beside the selector rather than leaving the reader to
infer it.
