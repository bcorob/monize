# Spec: the portfolio's result over a period

Status: **proposed.** Scope from kenlasko/monize#1392 ("Portfolio value over time:
change for the period counts deposits as gain"), part of the #1387 family.

Owner: net-worth. Related: `docs/specs/portfolio-movement-notifications.md` (the
same measure, asked per day), `docs/financial-calculation-contract.md` (a
subtotal is not a total), `docs/time-series-contract.md` (period boundaries),
INV-PORTRESULT-001.

---

## 1. The defect this exists to remove

The Portfolio Value Over Time report prints a "Period Change" of `last - first`
over the plotted series, and a "Period Return" of that difference over the first
point. Both count the reader's own deposits as gain.

The reproduction from the issue, with a price that never moves:

| Date | Event | Portfolio value |
| --- | --- | --- |
| 2026-01-02 | deposit 10,000; buy 100 units at 100 | 10,000 |
| 2026-06-01 | deposit 10,000; buy 100 units at 100 | 20,000 |

Over `2026-01-02 .. today` the report says **+10,000 / +100%**. The market did
nothing; the reader moved 10,000 of their own money in. A figure captioned
"Return" that reports a transfer as a gain is the #1387 class of defect: a
plausible number nobody can tell from a real one.

## 2. The measure

Let `A` be the scope's investment accounts (both sleeves; resolved by
`resolveInvestmentScopeAccountIds`, never by an account-type predicate --
INV-REPORT-001), `b` the baseline date and `e` the end date.

- `MV(t)` -- the scope's market value plus cash at the close of day `t`, in the
  reporting currency, from `NetWorthService.getDailyInvestments`: the same series
  the chart draws, with the same completeness bits (`fxComplete`,
  `pricesComplete`, `cashComplete`). Never a second valuation.
- `valueChange = MV(e) - MV(b)`.
- `netExternalFlows` -- the net cash that crossed the boundary of `C` from
  outside it on the days `(b, e]`, converted per day at that day's rate and
  summed in the reporting currency. **`C` is not `A`**: it is the subset of `A`
  whose ledger cash `MV` actually values -- the cash sleeves and the standalone
  investment accounts, `isValuationCashAccount`
  (`backend/src/net-worth/net-worth.service.ts`) -- and the same set is used on
  both sides of a transfer. One boundary, or a deposit posted straight to a
  brokerage row is subtracted from a value change that never held it. Which rows
  are external flow is
  `loadExternalFlowSubtotals` (`backend/src/securities/external-flow.util.ts`),
  the classifier the daily notification and the calendar already share: a
  deposit, a withdrawal, or a transfer leg whose counterparty is outside `A`.
  Investment-linked cash (BUY, SELL, DIVIDEND, interest, fees), a transfer
  between two accounts of `A`, and a VOID row are internal and are not flows.
- `investmentResult = valueChange - netExternalFlows`.
- `returnPercent = investmentResult / MV(b) * 100`, method `simple`, computed
  only when `MV(b) > 0`.

The lower bound is **exclusive**: `MV(b)` is the close of day `b` and already
contains every flow that landed on `b`. Counting those flows again would subtract
them from a starting value that already holds them.

### 2.1 Why `simple` and not TWR or Modified Dietz

`simple` divides the whole period's result by the value at the start. It ignores
*when* a flow arrived, so it understates the return of a period whose money
arrived late and overstates one whose money arrived early. It is named on the
wire (`returnMethod: "simple"`) precisely so a later time-weighted figure is a
new member of that union rather than a silent change of meaning under the same
caption.

Modified Dietz would weight each flow by the fraction of the period it was
invested for, and a true time-weighted return would chain sub-period returns
across every flow date. Both need a complete value on every flow date, not only
on the two boundaries, and both need a decision about a sub-period whose value is
unknown -- neither of which this change makes. Claiming "TWR" over an
unweighted ratio would be the `docs/financial-calculation-contract.md` section
8.4 defect: a second figure inheriting a denominator it does not describe.
`calculateTWR()` elsewhere in the codebase is not reused here; it answers a
different question over a different input.

## 3. Invariants

- **INV-PORTRESULT-001 (a period change is not a return).** Any surface that
  prints what a portfolio did over a period reports `valueChange`,
  `netExternalFlows` and `investmentResult` as three separate named figures, and
  prints a percentage only over `investmentResult`. A single "change" derived
  from the value series alone is a contribution reported as performance.
- **INV-PORTRESULT-002L (both boundaries complete, or no change).** `valueChange`
  is a value only when `MV(b)` and `MV(e)` are both complete
  (`fxComplete !== false && pricesComplete !== false && cashComplete !== false`).
  A subtotal minus a total is not a difference.
- **INV-PORTRESULT-003L (an unconvertible flow withholds the result, never
  shrinks it).** A flow subtotal with no rate for its day makes
  `netExternalFlows` `null` and `investmentResult` `null`, with the pair named.
  Dropping that currency would report the reader's own deposit as a gain, which
  is the defect this spec removes, in a second form.
- **INV-PORTRESULT-004L (zero start has no percentage).** `MV(b) = 0` yields
  `returnPercent: null` with reason `zeroStart`; the money figures are still
  reported.
- **INV-PORTRESULT-005L (a movement the classifier cannot count withholds the
  result).** When the window holds an investment action settled outside `C`, or
  a split parent mixing an investment line with ordinary cash, `investmentResult`
  and `returnPercent` are `null` with the reason `externallySettledTrade` or
  `mixedSplit`. `valueChange` and `netExternalFlows` are both still measured;
  what is unknown is whether their difference is the market's.

Every completeness read is `=== false` (absent is no information), and every
withheld figure names its cause at the surface that withholds it.

The four rules above carry an `L` suffix because they are LOCAL to this
document: the only entries of `docs/system-invariants.md` in this family are
INV-PORTRESULT-001 (above) and INV-PORTRESULT-002 (section 10.3).

## 4. Truth table

| MV(b) | MV(e) | flows | MV(b) value | valueChange | netExternalFlows | investmentResult | returnPercent | reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| complete | complete | complete | > 0 | number | number | number | number | -- |
| complete | complete | complete | 0 | number | number | number | `null` | `zeroStart` |
| incomplete | complete | complete | any | `null` | number | `null` | `null` | the point's own causes |
| complete | incomplete | complete | any | `null` | number | `null` | `null` | the point's own causes |
| complete | complete | incomplete | any | number | `null` | `null` | `null` | `missingRatePairs` |
| complete | complete | complete, but a movement is uncountable | any | number | number | `null` | `null` | `externallySettledTrade`, `mixedSplit` |
| no series | -- | -- | -- | `null` | `null` | `null` | `null` | `noValueSeries` |

A point's own causes are `incompletePrices` (a held position with no accepted
close), `incompleteCash` (a scoped cash account with no balance for the day) and
`missingRatePairs` (a component that did not convert), each carried with the ids
or pairs behind it.

## 5. Numerical examples

All in the reporting currency; the price never moves unless stated.

1. **The issue.** `MV(b) = 10,000` on 2026-01-02 (the deposit and the buy are
   both inside that close), `MV(e) = 20,000`, one 10,000 deposit on 2026-06-01.
   `valueChange = 10,000`, `netExternalFlows = 10,000`,
   `investmentResult = 0`, `returnPercent = 0`.
2. **A real gain beside a deposit.** Same as (1) but the price rises to 110 by
   `e`: `MV(e) = 22,000`, `valueChange = 12,000`, flows `10,000`,
   `investmentResult = 2,000`, `returnPercent = 20%` over the 10,000 start.
3. **A withdrawal.** `MV(b) = 10,000`, a 3,000 withdrawal, price flat:
   `MV(e) = 7,000`, `valueChange = -3,000`, `netExternalFlows = -3,000`,
   `investmentResult = 0`, `returnPercent = 0`.
4. **An internal transfer.** 5,000 moved from the cash sleeve to the brokerage,
   both in scope: `netExternalFlows = 0`, and the result is whatever the market
   did.
5. **A flow with no rate.** A 1,000 EUR deposit into a EUR account with no
   EUR->USD observation within `FX_MAX_RATE_AGE_DAYS` of its day:
   `netExternalFlows = null`, `investmentResult = null`,
   `missingRatePairs: ["EUR->USD"]`; `valueChange` still reported.
6. **A flow on the baseline day.** A 10,000 deposit dated `b` is already in
   `MV(b)`: it is **not** a flow of this period, and the result is unchanged.

## 6. Missing-data policy

`null` with a reason, never a substituted number. Specifically: never a value
change computed from a subtotal boundary; never a flow total that silently drops
an unconvertible currency; never a rate of 1 for a failed lookup; never a
percentage over an incomplete result; never `0` where the answer is unknown. A
known zero -- a period in which nothing moved, a scope with no flows -- is a
number and is reported as one.

The partial flow sum, when a rate is missing, is returned beside the `null` under
its own name (`knownFlowSubtotal`) rather than under `netExternalFlows`.

### 6.1 The two movements the flow classifier cannot count

Both are the coarse cases `external-flow.util.ts` documents. Each moves value
across the boundary of `C` without producing a countable flow, so the difference
`valueChange - netExternalFlows` stops being the market's. Each is **counted**
per window -- one `COUNT(*)` beside the flow query, in
`PortfolioPeriodResultService.countUnmeasuredFlows` -- and a count above zero
withholds `investmentResult` and `returnPercent` with the reason named. Counting
is deliberate: measuring either is a line-granular rewrite of the classifier, and
a count is all that withholding needs.

1. **`externallySettledTrade`.** An investment action in the window, on an
   account of `A`, whose settlement cash is outside `C`: an explicit
   `funding_account_id` naming an account outside it, a generated cash leg
   (`transaction_id`) posted to an account outside it, or an embedded investment
   split whose parent sits on one. A 10,000 BUY funded from a chequing account
   raises `MV` by 10,000 and leaves no cash leg in `C` at all, so the flow query
   reports zero and the naive subtraction calls the reader's own money a hundred
   per cent gain -- the defect of section 1, reached by a second route.
   An action that moved SHARES with no cash leg of any kind -- `TRANSFER_IN`,
   `TRANSFER_OUT`, `ADD_SHARES`, `REMOVE_SHARES`, and no linked leg on an
   account of `A` -- is counted SEPARATELY, as `externalShareTransfers`
   (`externalShareTransfersSql`). It withholds this figure for the same reason:
   shares arriving from outside are value entering `MV` with no cash to net it
   against. It does **not** withhold the invested figures, which value such a
   leg at the day's close; section 10.6 is the derivation. The two counts are
   apart because they withhold different things, and they share one `reason`
   because to a reader of the ACCOUNT's result they are one fact.
   A brokerage account with no linked cash sleeve settles its own trades on
   itself, which is outside `C` by construction; such a scope reports
   `valueChange` and withholds the result, which is the honest answer while its
   cash is not valued.
   A cash leg that is a TRANSFER whose counterpart sits on an account of `C`
   settled inside, and is not counted. That is the shape the QIF/CSV import
   writes: the action's cash leg is a row on the brokerage, linked to the
   sleeve's cash. The flow query is given the scope `A` as its
   `investmentScope` for the same decision, and leaves the sleeve leg out of
   the flows: a transfer whose counterpart is an investment action's cash leg
   on an account of `A` is the trade settling, not money crossing the
   boundary. Without it every imported BUY read as a withdrawal and every
   dividend as a deposit. The counterpart of an action on an account OUTSIDE
   `A` is still a flow: those shares are not in `MV`.
2. **`mixedSplit`.** A split parent in the window, on an account of `C`, that
   carries BOTH an investment-linked line and an ordinary one. The flow sum is
   over `t.amount`, so the classifier drops such a parent WHOLE: its ordinary
   cash is in `MV` and in no flow.

Neither is a boundary nobody can fix: recording the trade's cash inside the
portfolio, or splitting the mixed parent into its two rows, makes the period
measurable again. The surface says which one it hit.

Both withhold the ACCOUNT result only. The invested part (section 10) is drawn
around the securities, not the cash: `IV` is the positions' value and `K` and
`I` are each row's own `total_amount`, wherever its cash settled, and an
embedded split line carries its own investment row. A BUY funded from chequing
is `+T` of capital against `+T` of shares and a dividend paid to a bank is `+D`
of income, both exact. Reading these counts there withheld every invested
figure for any portfolio a QIF import built (#1516): that import points a
trade's cash leg at the brokerage row, so the count fired on nearly every trade
and dividend. Item 1's transfer rule now settles that shape inside `C` for the
account result too.

## 7. Where it is computed, and by whom

One answer, on the server:
`backend/src/net-worth/portfolio-period-result.service.ts` computes it and
`backend/src/net-worth/portfolio-period-result.util.ts` holds the pure decision
(`decidePeriodResult`), table-tested without a database exactly as
`decideDailyMovement` is. `GET /net-worth/investments-period-result` serves it
for the same scope and display currency the chart asked for.

**A caller names its window rather than dating it.** `period` is one of the
presets in `backend/src/net-worth/portfolio-period-presets.util.ts`, and the
route draws the window -- and the prior-close baseline where the preset has one
-- from that file, which is the same file the batch route in section 8 resolves
its windows from. `startDate`/`baselineDate` name an explicit window instead,
for the ranges no preset covers (`mtd`, a custom window); a caller sends one
form or the other, never both. The client does no arithmetic over the figures
either way.

The window a price chart DRAWS opens on the close the range is measured from
(`frontend/src/components/investments/portfolio-range-window.ts` mirrors
`presetEarliestDate` day for day; `PortfolioService.planOpeningClose` opens
the intraday 1W and 1M series on the same day's close), but it is still not
the period: `resolveRangePreset` widens 1D to a week so a daily fallback has
more than one point, and resolves `all` to no start date at all. Sending the
drawn window to this route is what made the chart's card measure a week under
"1D" and report nothing under "All time". A chart therefore names its range;
it never sends the window it drew. The chart's own first point is then the
close `startPriceDate` names, dated by that session
(`docs/frontend/financial-figures.md`, issue #1461).

**`startPriceDate`** answers which trading SESSION `startDate`'s value came
from: the newest day on or before it carrying a close for anything the scope
held (`NetWorthService.getLastPricedDays`). `startDate` is a calendar day and
the value series prices every calendar day from the latest close at or before
it, so a Monday 1D window opens on Sunday and is measured from Friday's close.
A surface printing `startDate` as the close it reports against names a day the
market was shut, so the surfaces print `startPriceDate`. `null` is unknown --
never the calendar day in its place.

## 8. The batch route: every window, one valuation

The Investments page reports the result over every trailing window at once (1D,
1W, 1M, 3M, YTD, 1Y, 2Y, 5Y, 10Y and all-time). One call to the single-range
route per window would rebuild the daily valuation that many times --
`NetWorthService.getDailyInvestments` is the expensive part -- and the widest
window's series already contains every shorter window's points, so
`GET /net-worth/investments-period-results` builds the series ONCE for the
widest window it reports and derives each preset by slicing it
(`backend/src/net-worth/portfolio-period-results-batch.service.ts`).

The route takes `periods` (a comma-separated subset of the closed set
`1d,1w,1m,3m,ytd,1y,2y,5y,10y,all`; all of them when omitted), plus the same
`accountIds` and `displayCurrency` as the single-range route, and answers
`{ currency, asOf, periods: { [preset]: PortfolioPeriodResult } }`. An unknown
preset is a 400: the windows are the server's own arithmetic
(`backend/src/net-worth/portfolio-period-presets.util.ts`), which is what keeps
the Investments page, the chart and any later surface from disagreeing about
where a month begins. The arithmetic follows the client's own range picker
where the two offer the same caption -- `2y` is a rolling 730 days, as the
chart's `2y` button draws it -- so one page does not open the same window on
two days. `ytd` opens on 31 December of the previous year rather than on
1 January, so the year is measured from the close of its last trading session;
the charts' YTD window opens on the same day.

### 8.1 Which windows a scope is shown

`periods` is partial, and the two ways a window can fail to carry a figure are
different answers:

- **Present, with every figure `null` and a reason.** The window exists for
  this scope and could not be measured: a boundary the series does not reach,
  a missing price, a rate the history does not have. The card reads it as
  "n/a" and names the cause, because the reader can often repair it.
- **Absent.** This portfolio has no such window. `2y`, `5y` and `10y` are
  reported only where the scope's history reaches back to their start
  (`isHistoryGatedPreset`), and `all` only where the scope has ever held
  anything. A five-year row on a two-year-old portfolio is a permanent "n/a"
  with nothing behind it to fix, so it is not sent and not drawn. The shorter
  windows are never gated: every portfolio is shown its day, week, month,
  quarter, year-to-date and year, and a young one reports them from the day it
  started holding anything.

A gated window that is not reported does not widen the valuation either: the
series is built over the widest window actually reported, so a three-year-old
portfolio never values ten years of empty days.

**Where `all` opens.** On the day the scope's first non-VOID investment
transaction settled, measured from the close BEFORE it -- that day's own close
already holds the purchase. This is the same boundary
`getInvestedResultSinceInception` draws (section 10.7), from the same
`firstInvestmentDate`, so the card's all-time row and the summary card's
since-inception return are one answer rather than two.

**What is sliced, and what is not.** Nothing is recomputed: the same
`decidePeriodResult` decides every figure, from the same series, the same flow
classifier and the same per-day conversion.

| Per preset | Taken from the one wide load |
| --- | --- |
| MV(e) | the series' last point, shared by every preset |
| MV(b) | the last point on or before the prior-close baseline (1d, 1w), else the first point inside the window |
| flows | the per-day subtotals dated strictly after that preset's own lower bound, folded against one rate index (`backend/src/net-worth/period-flow-fold.util.ts`) |
| unmeasurable movements | the per-day counts over the same days (`backend/src/net-worth/unmeasured-flows.util.ts`) |

Slicing is equivalent because neither input depends on how wide a window was
asked for: a day is valued from the latest accepted close on or before it, and
`buildRateIndex` loads enough rows that a date resolves the same in any window
(issue #1390 is the defect that established the second). The equivalence is
asserted rather than assumed:
`backend/src/net-worth/portfolio-period-results-batch.service.spec.ts` runs the
batch route and the single-range route over one fixture and compares them
preset by preset, giving the single route exactly the dates the preset file
resolves for that window (`presetWindowStart`, `usesPriorCloseBaseline`).

**A window the series does not reach back to** -- a portfolio three days old
asked for its year -- is every figure `null` with `noValueSeries`, and the
surface reads it as "n/a". Measuring from the first day the scope held anything
would put a number under a caption promising a year of it, which is the
security performance card's "n/a rather than 0%" rule, for the same reason.

## 9. Test matrix

Backend unit (`portfolio-period-result.util.spec.ts`,
`portfolio-period-result.service.spec.ts`):

| Case | Expected |
| --- | --- |
| the issue's two deposits, flat prices | result `0`, percent `0`, flows `10,000` |
| a market gain beside a deposit | result is the market's part only |
| a withdrawal | flows negative, result `0` |
| an internal transfer between two scoped accounts | flows `0` |
| a flow day with no rate | flows and result `null`, pair named |
| first point incomplete | `valueChange` and result `null`, the point's causes |
| last point incomplete | `valueChange` and result `null`, the point's causes |
| `MV(b) = 0` | percent `null`, reason `zeroStart`, money reported |
| empty series | every figure `null`, reason `noValueSeries` |
| an explicit `baselineDate` | the baseline's close is the start, flows after it |
| `period: '1d'` | the window is the day and the close before it, never the week the chart draws |
| `period: '3m'`, `'1y'`, `'5y'` | the day `presetWindowStart` names, not the day before it |
| `period: 'ytd'` | opens on 31 December of the previous year, whose value is that year's last close; flows from 1 January on are inside the window |
| `period: 'all'` | opens on the close before the scope's first holding, and equals `getInvestedResultSinceInception` |
| `period: 'all'` on a scope that never held anything | every figure `null`, reason `noValueSeries`, no series valued |
| a boundary on a day with no close | `startPriceDate` is the session before it; `null` where nothing was priced |
| a TRANSFER_IN carrying a basis far from the day's close | valued at `quantity x close`, so the P&L is the market move alone |
| a share-moving leg nothing priced | day incomplete, reason `incompletePrices`, the security dated in `incompleteRanges` |
| a share transfer and the ACCOUNT's result | still `null` with `externallySettledTrade`; only the invested figures report |
| a BUY settled outside `C` | result and percent `null`, reason `externallySettledTrade`; the invested figures still report |
| an imported trade: cash leg on the brokerage, transfer counterpart in `C` | not counted as settled outside; the sleeve leg is not a flow; result reported |
| cash in `C` paying for a trade on a brokerage outside `A` | still a flow |
| a mixed split parent in the window | result `null`, reason `mixedSplit`; the invested figures still report |
| the flow query's account set | the valued cash accounts, not the whole scope |

Backend unit
(`backend/src/net-worth/portfolio-period-results-batch.service.spec.ts`):
equivalence with the single-range route for every preset reported, the series
built once over the widest window, a flow counted in the windows that contain
it and in no other, a window an uncountable movement withholds while its
neighbours stay measurable, a short history, a currency override and an empty
scope. For the windows of section 8.1: a gated window left out when the history
does not reach it and reported when it does, the boundary drawn at the window's
own start rather than the widest one asked for, `all` opening on the close
before the first holding, `all` equal to `getInvestedResultSinceInception`, no
all-time window for a scope that never held anything, and the history asked for
once, or not at all when no window needs it.

Backend unit (`portfolio-period-results-batch.service.spec.ts`): equivalence
with the single-range route for every preset, the series built once over the
widest window, a flow counted in the windows that contain it and in no other, a
window an uncountable movement withholds while its neighbours stay measurable,
a short history, a currency override and an empty scope.

Frontend (`PortfolioValueReport.test.tsx`): the KPI cards show value change, net
deposits and withdrawals, and the investment result as three separate figures;
each relabels through `PartialTotal` / the unknown marker when the server
withholds it, reading every flag as `=== false`.

The adversarial case, per `docs/financial-calculation-contract.md` section 8:
example (1). A naive `last - first` passes every other case in this matrix and
fails exactly that one.

---

## 10. The invested part: P&L and time-weighted return

Status: **proposed.** Scope from kenlasko/monize#1392, the second reading of the
same caption. Sections 1-9 stay exactly as they are: the account-level measure
(`valueChange`, `netExternalFlows`, `investmentResult`, `returnPercent`) is
unchanged, still served by the same fields, and INV-PORTRESULT-001 still governs
it. This section adds a SECOND measure beside it, over the same series and the
same load, and says which surface reads which.

### 10.1 The defect this exists to remove

"Portfolio performance" is read as *"how much did my investments earn or lose
in this period"*. The measure of sections 2-5 answers a different question:
*"how much did the whole investment account move, once the cash I moved across
its boundary is taken out"*. The two differ wherever cash sits inside the
scope, because `MV` counts that cash:

| Day | Event | MV | IV (securities only) |
| --- | --- | --- | --- |
| 2026-01-02 | deposit 10,000; buy 8,000 of a security | 10,000 | 8,000 |
| 2026-02-02 | the security is up 10% | 10,800 | 8,800 |

`investmentResult` is `+800` on `MV(b) = 10,000`, so `returnPercent` reports
**+8%**. The investments returned **+10%**; the other 2,000 is uninvested cash
that earned nothing and should not be in the denominator. Moving the cash in or
out moves that percentage without a single share changing hands, which is the
#1387 class of defect in its second form: a plausible number nobody can tell
from a real one.

`MV(e) - cash(e) - (MV(b) - cash(b))` is **not** the repair, and is explicitly
rejected: it is right only when no buy, sell, dividend, share transfer or
composition change happened inside the window, which is exactly when nobody
needs it. A purchase moves cash into securities and reads as a gain; a sale
reads as a loss; a fully sold position leaves the "today's holdings" view
altogether. The invested part has to be measured the same way the account-level
part is -- from the ledger, day by day -- or it is a different kind of wrong.

### 10.2 Definitions

Let `A` be the scope (both sleeves, `resolveInvestmentScopeAccountIds`), `b` the
baseline date and `e` the end date, and let every figure be in the reporting
currency.

- **`IV(t)`** -- the scope's INVESTED market value at the close of day `t`:
  securities only, no cash. Every position is reconstructed from the ledger as
  of `t` by the same replay `MV(t)` uses (`applyActionToQuantity` over every
  non-VOID investment transaction dated on or before `t`), so a security bought
  and fully sold inside the window is held on the days it was held and gone
  afterwards, and a security sold before today is still valued on the days it
  was owned. Each position is priced at the latest accepted close on or before
  `t` (`docs/time-series-contract.md`) in the security's own currency and
  converted at `t`'s own rate (`resolveFxRate` through the bulk rate index,
  INV-FX-001). It is the `securitiesValue` component of the very point
  `getDailyInvestments` already produces: `value = IV(t) + cash(t)`, exposed
  rather than recomputed. A second valuation would be a second answer to "what
  was this worth".
- **`K(d)`** -- net capital flow INTO the invested part on day `d`, split into
  the two halves the return needs:
  - `capitalIn(d)`: BUY (and REDEEM's opposite, i.e. none), TRANSFER_IN,
    ADD_SHARES.
  - `capitalOut(d)`: SELL / REDEEM, TRANSFER_OUT, REMOVE_SHARES,
    RETURN_OF_CAPITAL (cost paid back, not earned; `docs/specs/return-of-capital.md`).
  - `K(d) = capitalIn(d) - capitalOut(d)`.

  A row's value is its **executed total** where it carries one -- BUY and SELL
  store `total_amount` commission-in on an acquisition and commission-out on a
  disposal (`deriveInvestmentTotal`), which is Monize's cost-basis convention
  (`acquisitionCost`) -- and `quantity * price` where it does not, which is the
  share-moving legs' carried basis (the same expression
  `computeFirstActiveMonthCostBasis` reads for a transfer). Each row is in its
  security's currency and is converted at ITS OWN day's rate, exactly as `IV`
  and the external flows are.
- **`I(d)`** -- investment income received on day `d`: the `CASH_INCOME_ACTIONS`
  set (DIVIDEND, INTEREST, CAPITAL_GAIN and the short/long refinements), at
  `total_amount`, converted at day `d`'s rate. Income is RETURN: it leaves the
  invested part as cash but the invested part earned it.
- **`R(d)`** -- distributions reinvested on day `d`: REINVEST and its
  refinements (`reinvestedIncome` in `INVESTED_FLOW_KIND_BY_BASE_ACTION`), each
  valued by `reinvestedIncomeAmount` (the stored total, otherwise quantity x
  price + commission, because a reinvest created in the app stores no total),
  converted at day `d`'s rate.
  A reinvestment is the DIVIDEND and the BUY it stands for in one row, so it is
  income AND capital: `R` is added to both printed figures below and nets out
  of the P&L. Its shares are already in `IV(d)` and no value crossed the
  boundary, so neither return chain reads it. (Until Discussion #1670 it was
  printed in neither figure, which left a reinvested dividend out of every
  income number while the P&L, unchanged by this, already held it.) A legacy
  row with neither a total nor a price is in no cost basis and in neither
  figure.
- **Neither capital nor income:** SPLIT (a ratio, no value crosses anything).
- **`investmentPnl(b, e) = IV(e) - IV(b) - sum K(d) + sum I(d)`** over
  `d` in `(b, e]`. The lower bound is exclusive for the same reason section 2
  gives: `IV(b)` is a close and already holds everything dated `b`.
- **`investedValueChange(b, e) = IV(e) - IV(b)`** -- what the securities are
  worth at the end less what they were worth at the start: the last point an
  investment chart draws less its first (section 10.9). It is the invested
  part's counterpart of the account-level `valueChange`, and the P&L is made of
  it exactly:

  ```
  investmentPnl = investedValueChange - investmentCapitalFlows + investmentIncome
  ```

  where `investmentCapitalFlows = sum (K(d) + R(d))` and
  `investmentIncome = sum (I(d) + R(d))` over the same days. `R` is in both and
  cancels, so the P&L is the `IV(e) - IV(b) - sum K(d) + sum I(d)` above. A
  surface that prints the three beside the result therefore prints figures
  that add up, which the account-level `valueChange` / `netExternalFlows` pair
  beside an invested result did not.
- **`investmentReturnPercent(b, e)`** -- a true time-weighted return, chained
  daily over `(b, e]`:

  ```
  base(d)   = IV(d-1) + capitalIn(d)
  ending(d) = IV(d)   + capitalOut(d) + I(d)
  f(d)      = base(d) > 0 ? ending(d) / base(d) : 1
  TWR       = (prod f(d) - 1) * 100        method "twr"
  ```

  A purchase is funded at the START of the day (it enters the base, so buying
  cannot be a gain) and a disposal or a distribution leaves at the END of it (it
  stays in the numerator, so selling cannot be a loss). **This is a deliberate
  departure from a pure start-of-day convention for every flow**, which the
  first draft of this section proposed: under it a sale of everything makes
  `base(d) = IV(d-1) - proceeds`, which is negative for a profitable sale, and
  the day that realised the gain would drop out of the chain (case 6 below). The
  split convention is what makes a same-day buy-and-sell, a full liquidation and
  an internal share transfer all come out right at once.

  A day with no invested capital contributes factor 1 -- it is a day nothing was
  at risk, not a day of zero return. When NO day of the window had
  `base(d) > 0`: the return is `0` if `investmentPnl` is also `0` (nothing was
  invested and nothing was earned -- a known zero, case 1), and `null` with
  reason `zeroStart` otherwise (a result over no invested capital has no ratio).

The chained factors are written once -- `subPeriodFactor` and
`chainTwrPercent` (`backend/src/common/time-series/twr-chain.util.ts`) -- and
`investedPeriodResult` is their only caller. The portfolio summary's
`timeWeightedReturn` used to be a second implementation beside it
(`PortfolioCalculationService.calculateTWR`): it valued every sub-period
boundary from stored closes alone, OMITTED a position with no close on a
boundary from the value rather than withholding the figure, read its final
sub-period from a different price source, and counted no income and no
invested/cash split. It is removed (section 10.7): the summary asks this same
measure for the window since inception.

### 10.3 Invariants

- **INV-PORTRESULT-002 (cash is not an investment).** The invested part's P&L
  and return exclude uninvested cash, deposits and withdrawals entirely. Cash
  is not in `IV`, so it is in neither figure and in neither the numerator nor
  the base of the percentage; a deposit, a withdrawal or a transfer between the
  reader's own accounts moves neither figure at all. `investmentReturnMethod` is
  `"twr"` and is named on the wire so a later method is a new union member
  rather than a silent change of meaning.
- **Measured from the ledger, never from today's holdings.** Every day's `IV` is a replay of the transactions dated on or
  before it. A security fully sold before today counts on the days it was
  owned; a `SELECT` over current holdings priced back through time would drop
  it and report a window that never happened.
- **A capital flow is not a result.** A buy funded by a
  deposit, a sale, a share transfer and a quantity change contribute factor 1 on
  their own day and cancel out of `investmentPnl`. Only a price change, a
  distribution and a reinvestment are result.
- **Completeness.** Both figures are `null` when any day the chain spans has an
  `IV` that is a subtotal (`pricesComplete === false` or `fxComplete === false`
  on that point), when a capital or income row could not be converted
  (`missingRatePairs`). A movement the account's flow classifier cannot count
  (section 6.1) does NOT withhold them: it is a fact about where cash settled,
  and neither figure reads the cash. Never a
  chain over a subtotal -- the rule `calculateTWR` already keeps for its own FX
  gaps. Every read is `=== false`.
- **`investedValueChange` is two-ended.** It is a difference of two closes, not
  a chain, so it is known whenever `IV(b)` and `IV(e)` are both complete: a
  subtotal on a day between them or a flow that did not convert withholds the
  P&L and the return but not this, exactly as the same
  causes leave the account-level `valueChange` standing. It is computed on the
  server beside the P&L, never by a client subtracting `investedValueEnd` from
  `investedValueStart`: those two are nulled with the rest of a withheld
  decision, so a client difference would be unknown where the change is known.

`cashComplete` is deliberately NOT read: cash enters `IV` nowhere, so a cash
account with no balance for a day cannot make the invested figures wrong. It
still travels on the point, still withholds the account-level `valueChange`
(INV-PORTRESULT-002L of section 3, unchanged) and is still reported by the
incomplete-data details. `fxComplete` IS read although it covers the day's cash
conversion too: it is a superset of the securities' own FX gaps, so reading it
withholds conservatively and never over-claims. Splitting it into a
securities-only bit is a field nobody needs yet.

### 10.4 Truth table

| IV(b) | IV(e) | any day in (b,e] | flows/income | base(d) > 0 on some day | investedValueChange | investmentPnl | investmentReturnPercent | investedReasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| complete | complete | all complete | complete | yes | number | number | number | -- |
| complete | complete | all complete | complete | no, and pnl = 0 | number | `0` | `0` | -- |
| complete | complete | all complete | complete | no, and pnl != 0 | number | number | `null` | `zeroStart` |
| subtotal | any | any | any | any | `null` | `null` | `null` | that point's causes |
| any | subtotal | any | any | any | `null` | `null` | `null` | that point's causes |
| complete | complete | one is a subtotal | any | any | number | `null` | `null` | that point's causes |
| complete | complete | all complete | a row did not convert | any | number | `null` | `null` | `missingRatePairs` |
| complete | complete | all complete | complete, but a movement is uncountable (6.1) | yes | number | number | number | -- |
| no series | -- | -- | -- | -- | `null` | `null` | `null` | `noValueSeries` |

`investmentCapitalFlows` and `investmentIncome` are reported as numbers
whenever the conversion of the rows behind them succeeded, even where the
prices withhold the two headline figures: they are what the reader moved and
what the portfolio paid out, and neither depends on a price. They are `null`
only when a row did not convert.

### 10.5 The twelve cases

Flat prices unless stated; reporting currency = account currency unless stated.
`b` is the day before the first event.

1. **Cash only.** Deposit 10,000, no securities, one month. `IV` is 0 every
   day; no capital, no income. `investmentPnl = 0`. No day has `base > 0` and
   the P&L is zero, so `investmentReturnPercent = 0`. (The account-level
   `valueChange` is +10,000 and `investmentResult` 0 -- unchanged.)
2. **Deposit and buy.** Deposit 10,000 on `d1`, buy 8,000 of a security the
   same day, 2,000 stays cash. `IV(d1) = 8,000`, `capitalIn(d1) = 8,000`,
   `base(d1) = 0 + 8,000 = 8,000`, `ending(d1) = 8,000`, `f = 1`. Later days
   `f = 1`. `investmentPnl = 8,000 - 0 - 8,000 = 0`; return `0%`.
3. **The security gains 10%.** As (2), then `IV(d2) = 8,800`.
   `investmentPnl = 8,800 - 0 - 8,000 = +800`.
   `f(d2) = 8,800 / 8,000 = 1.1`; return **+10%**, not +8%: the 2,000 of cash
   is in neither the numerator nor the base.
4. **A large late deposit.** Case 3 plus a 50,000 deposit the day before `e`,
   left uninvested. It is not an investment transaction, so it is in no `K`, no
   `I` and no `IV`. Still `+800` and **+10%**. (`valueChange` moves by +50,000;
   that is the account-level measure's business.)
5. **A second purchase at an unchanged price.** Case 3, then buy another 4,000
   on `d3`. `base(d3) = 8,800 + 4,000 = 12,800`, `ending(d3) = 12,800`,
   `f(d3) = 1`. `investmentPnl = 12,800 - 0 - 12,000 = +800`; return still
   **+10%**. The purchase changed neither figure.
6. **A full sale inside the window.** Buy 8,000 on `d1`, sell the lot for
   9,000 on `d4`. `IV(d4) = 0`, `capitalOut(d4) = 9,000`.
   `investmentPnl = 0 - 0 - (8,000 - 9,000) = +1,000`.
   `f(d4) = (0 + 9,000) / 8,000 = 1.125`; return **+12.5%**. Under a pure
   start-of-day convention `base(d4)` would be `8,000 - 9,000 = -1,000` and the
   day that realised the whole gain would contribute factor 1 -- which is why
   the convention is split.
7. **The proceeds sit as cash.** Every day after `d4`: `IV = 0`, so
   `base = 0` and `f = 1`. `investmentPnl` stays `+1,000` and the return stays
   **+12.5%**. Money that stopped being invested stops earning.
8. **A dividend.** 100 paid into cash on `d5` while `IV(d4) = IV(d5) = 8,000`.
   `investmentPnl = 8,000 - 8,000 - 0 + 100 = +100`;
   `f(d5) = (8,000 + 100) / 8,000 = 1.0125`, so the return includes it
   although the money ended up as cash.
9. **A position closed before today.** Security X bought for 5,000, grown to
   6,000, fully sold on `d100`; security Y bought for 6,000 on `d150` and still
   held at `e` at 6,600. Over a 1Y window `IV` is X's value up to `d100`, zero
   between, Y's after: `investmentPnl = 6,600 - 0 - (5,000 + 6,000 - 6,000) =
   +1,600`, and the chain carries X's `1.2` on its gain day and Y's `1.1` on
   its. A "today's holdings" reconstruction would have reported only Y.
10. **An internal transfer.** Shares worth 3,000 moved from one scope account
    to another on `d6`: `capitalIn(d6) = 3,000` and `capitalOut(d6) = 3,000`
    from the two legs, `IV` unchanged. `f(d6) = (IV + 3,000) / (IV + 3,000) =
    1`, `K(d6) = 0`, `investmentPnl` unchanged. A cash transfer between the same
    two accounts is in no investment row at all and changes nothing.
11. **A reporting currency that is not the security's.** Every component is
    converted at its own day: `IV(t)` at `t`, each `K(d)` and `I(d)` at `d`
    (INV-FX-001, `resolveFxRate` through the shared rate index). The economic
    result is the same figure a single-currency reader would see, plus the
    genuine currency effect on the value; no component is ever converted at
    today's rate or at 1.
12. **A missing price or rate inside the window.** A day whose `IV` is a
    subtotal, or a capital row with no rate for its day: `investmentPnl` and
    `investmentReturnPercent` are both `null`, with `incompletePrices` /
    `missingRatePairs` and the ids or pairs behind them. Never a number that
    looks like the others.

In every case above that reports a P&L, `investedValueChange -
investmentCapitalFlows + investmentIncome = investmentPnl` to the cent. Case 4
is the one that shows why the surfaces print `investedValueChange` rather than
`valueChange`: the account moved by 50,800, the securities line by 800, and only
the second is the chart's change.

### 10.6 Missing-data policy

As section 6, applied to the new figures: `null` with a named reason, never a
substituted number, never a chain over a subtotal, never a rate of 1 for a
failed lookup, never a percentage over an incomplete P&L. A known zero -- case 1
-- is a number and is reported as one.

**A share-moving leg is valued at the day's accepted close.** `IV` moves by the
position's MARKET value, so a leg valued at anything else -- the basis the row
carries, or nothing at all -- leaves the difference in `investmentPnl` as a gain
nobody made. `foldInvestedFlows` therefore values `TRANSFER_IN`,
`TRANSFER_OUT`, `ADD_SHARES` and `REMOVE_SHARES` at `quantity x close`, where
`close` is `positionCloseAsOf` over the very series the valuation was built
from (`shareLegCloseFrom`). `IV` and `K` then move by one number for one day's
shares and cancel exactly, whatever cost the row was recorded at.

This closes what were two open items, and it is why `externalShareTransfers` is
counted apart from `externallySettledTrades` in section 6.1: a portfolio built
by transferring holdings in used to report "n/a" for every window those
transfers fell in, which is every long window and always `all`.

What remains is narrowing rather than corrupting:

1. **A leg nothing priced.** Where no accepted close exists on or before the
   leg's date, the shares are in `IV` with no capital flow to net them. The
   fold names the security on that day (`InvestedFlowDay.unpricedSecurityIds`),
   which makes the day a subtotal, withholds the window with `incompletePrices`
   rather than `externallySettledTrade`, and dates the security in
   `incompleteRanges` (`withFlowUnpricedSecurities`). A price to add, on one
   security's price history, rather than a movement nobody can act on.
2. **A linked pair whose legs fall on different days** shifts value between two
   days' factors without changing `investmentPnl`; both legs are valued at their
   own day's close, so neither is a gain.

### 10.7 Where each surface reads which measure

Both measures come from the same route and the same load. `IV` is the
`securitiesValue` component of the daily point, and the capital and income rows
are one more grouped read beside the external-flow one, folded through the same
`RateIndex` with the same `fetchMissing` opt-out. The batch route keeps ONE
series, ONE flow load, ONE income/capital load and ONE rate index, and derives
each preset by slicing; the TWR for a preset is a product over that preset's own
days, O(days).

| Surface | Series it plots | Headline figures |
| --- | --- | --- |
| "Portfolio performance" card (Investments) | -- | `investmentReturnPercent` primary, `investmentPnl` secondary |
| Portfolio summary card's "TWR (time-weighted)" | -- | `investmentReturnPercent` since inception |
| "Portfolio value over time" chart (Investments) | `securitiesValue` | "Value Change" `investedValueChange`, `investmentPnl` with `investmentCapitalFlows` and `investmentIncome` beneath, `investmentReturnPercent` |
| Portfolio value widget (dashboard) | `securitiesValue` | `investmentPnl`, `investmentReturnPercent`; its tooltip names `investedValueChange`, `investmentCapitalFlows`, `investmentIncome` |
| Portfolio Value report | `securitiesValue` | "Value Change" `investedValueChange`, "Net Invested" `investmentCapitalFlows` with `investmentIncome` beneath, `investmentPnl`, `investmentReturnPercent` |
| Monthly Comparison report, per-account performance | -- | `investmentReturnPercent` over `1y` to the report month's end, per brokerage account |
| Net worth chart (dashboard) | net worth, cash included | unchanged |
| Daily movement notification, calendar day layer | `value` | `valueChange`, `netExternalFlows`, `investmentResult` |

**The summary card is the fourth consumer, over a window of its own.** Its
"TWR (time-weighted)" is this measure since INCEPTION: the baseline is the day
before the scope's earliest non-VOID investment transaction (`IV(b)` is a close
and already holds everything dated `b`) and the end is the routes' own
`todayYMD()`. `PortfolioPeriodResultService.getInvestedResultSinceInception`
resolves those two dates and then runs `getPeriodResult`, so the summary and
the period card share one series, one capital and income load, one rate
index and one decision; a spec asserts the two are the same answer for one
fixture, and the batch route's own `all` window is that same answer again
(section 8.1). The summary carries `timeWeightedReturnReasons` and
`timeWeightedReturnSince` beside the figure, on the REST shape, the LLM summary
and the MCP payload, so a withheld return names its cause instead of reading as
"n/a" or as zero. (The MCP OUTPUT SCHEMA declares neither: the loose object
carries them to the caller either way, and `get_portfolio_summary` is at its
`tools/list` byte budget, which a declared field would break.)

**A withheld return names its gaps, not only its cause.** Every period result
carries `incompleteRanges`: the window's per-point diagnostics folded per key
into runs of consecutive points, one list per cause (`prices`, `rates`, `cash`),
by `foldIncompleteData`
(`backend/src/net-worth/incomplete-data-ranges.util.ts`) -- the server-side twin
of the client fold the chart and the report already use, with the same
semantics, the client's own cases ported, and a bound of 50 runs per cause
(newest kept, `truncated` saying so) because a years-long gap across many
securities would otherwise travel on every response. The union sets
`unpricedSecurityIds`, `missingRatePairs` and `unknownCashAccountIds` are
unchanged: they say WHAT is missing, and the ranges say when. The single route
folds the points it valued; the batch route folds each preset's own slice, so a
preset does not report a gap from before its window opened. The summary turns
that into `returnDiagnostics` -- each run resolved to a symbol and a name, a
pair, or an account name, with the window's baseline in `since` -- resolving a
security absent from today's holdings by id, because the gap usually sits on
exactly the position that was sold out or made inactive. The card renders it
with the report's own `IncompleteDataDetails`, so the reader lands on the
security's price history (`docs/financial-calculation-contract.md` section 1.3:
what is missing, how to obtain it, what was tried). `returnDiagnostics` is
undeclared in the MCP output schema for the same byte-budget reason as the two
fields above.

The summary's other two figures are NOT this
measure and keep their own captions: `totalGainLossPercent` ("Simple Return")
and `cagr` are cost-basis measures, not returns over time.

The investment surfaces draw the INVESTED value, so the chart, its KPIs and the
card answer one question rather than three. The figures that explain the result
are the invested part's too: the value change printed beside a chart is its own
line's (`investedValueChange`), and what separates it from the result is the
capital paid into the securities and the income they paid out, not the cash the
reader deposited. They printed the account-level `valueChange` and
`netExternalFlows` until the reader found that the "Value Change" under a chart
matched neither the line nor the result beside it. `value` (securities plus cash) stays
on the point and the account-level fields stay on the period result: the daily
movement notification and the calendar layer measure the account, and the net
worth chart is net worth. Nothing that is about the account loses its cash.

Because those charts plot `securitiesValue`, a point is withheld from them on
`pricesComplete === false` or `fxComplete === false` only; `cashComplete` no
longer withholds an investment chart's point, because cash is not on it. The
incomplete-data details still report a cash gap -- the reader who has one wants
to know -- and the account-level fields still withhold on it.

### 10.8 Test matrix

Backend unit:

| Suite | Case |
| --- | --- |
| `invested-period-result.util.spec.ts` | the twelve cases above, table-driven, each with its worked numbers |
| `invested-period-result.util.spec.ts` | a mid-window subtotal day withholds both figures; a flow that did not convert withholds both |
| `invested-period-result.util.spec.ts` | `investedValueChange` reconciles with the P&L across the cases; it stands through an interior gap and an unconverted flow; it is `null` for a subtotal at either end and for no series; `cashComplete` does not withhold it |
| `series-dates.util.spec.ts` | `monthEndSampleDates`: a mid-month start, a start on the 1st and on a month-end, an end on a month-end, a leap February, one day, a reversed window |
| `net-worth.service.spec.ts` | the sampled series' points equal the daily series' on the same days, its first and last included; 'all' opens on the day before the first investment transaction; a `monthEnd` breakdown values its first point on the start day, before a purchase later that month |
| `twr-chain.util.spec.ts` | `subPeriodFactor` refuses a non-positive base; `chainTwrPercent` over an empty chain is `null` |
| `invested-capital-flow.util.spec.ts` | the SQL binds every placeholder it names and no other; the fold splits capital from income by the shared constant and converts each day at its own rate |
| `investment-replay.util.spec.ts` | `INVESTED_FLOW_KIND` covers every `InvestmentAction` member (a list that means something, checked against the enum) |
| `portfolio-period-result.service.spec.ts` | a 50,000 deposit the day before the end changes neither new figure while it does change `valueChange` (case 4) |
| `portfolio-period-results-batch.service.spec.ts` | batch == single per preset on the new fields too |
| `portfolio-period-result.service.spec.ts` | `getInvestedResultSinceInception` equals `getPeriodResult` asked for the first transaction date with the day before as the baseline; a scope with no transaction, and one with no accounts, are the empty decision; a split is a factor of 1 and no capital; an FX gap or an unpriced position on a day the chain spans withholds both figures |
| `portfolio.service.spec.ts` | the summary prints that return, its reasons and its baseline date, and withholds it with `incompletePrices` where the removed `calculateTWR` reported a gain |
| `incomplete-data-ranges.util.spec.ts` | the client fold's own cases, ported; a gap of one point splits a run; the bound keeps the newest runs and sets `truncated` |
| `portfolio-period-result.service.spec.ts` | a security unpriced on days 3-5 and 9 folds into two runs; a window with no gap reports none; past the bound the newest 50 are kept |
| `portfolio-period-results-batch.service.spec.ts` | each preset's `incompleteRanges` equals the single route's, and the quarter does not report a gap the year reaches back to |
| `portfolio.service.spec.ts` | `returnDiagnostics` names a held security from the holdings already valued, loads the name of one nobody holds today, names the cash account, and is empty over a window with no gap |

Backend integration (`backend/test/integration/`): the capital/income loader
against real PostgreSQL -- a BUY, a SELL and a DIVIDEND fixture, grouped per day
and currency, parsed by the server (the `$n`-binding lesson: every placeholder a
statement names is bound and no other).

Frontend: the card reads `investmentReturnPercent` and `investmentPnl`; the
subtitle and footnote say cash is excluded; the Investments page puts the three
cards in one grid in the order summary, performance, allocation; the chart, the
widget and the report plot `securitiesValue` and show 0 / 0% for a cash-only
deposit.

The adversarial case, per `docs/financial-calculation-contract.md` section 8:
case 4. A `totalValue - cash` patch at the two ends passes cases 1-4 and fails
5, 6, 7 and 9.

### 10.9 A chart's boundaries are its figures' boundaries

INV-PORTCHART-001. The Investments chart, the Portfolio Value report and the
dashboard widget each draw a line and print, beside it, figures measured
between two closes. The line opens on the first of those closes and ends on the
second, on every range:

- **Daily ranges** request the series from the day the period is measured from
  (`usePortfolioRangeWindow`'s `start`, mirroring
  `portfolio-period-presets.util.ts`), so the first point IS `IV(b)`.
- **Long ranges** (the report's 6M, 2Y, 5Y and All, the chart's 5Y and All, the
  widget's 1Y and longer, and a custom report window over a year) are the same
  daily valuation sampled at month-ends
  (`sampling: 'monthEnd'` on `investments-daily`, `granularity: 'monthEnd'` on
  `investments-breakdown`; `docs/time-series-contract.md` section 2.7). Their
  first point is the start day's valuation and their last the end day's. They
  drew the stored month-end snapshots until this section: the first point was
  the end of the starting month -- or a cost-basis stand-in for an account's
  first month -- so the line and the figures opened on different days.
- **All** opens on the day before the scope's first investment transaction,
  where the period result's `all` window does (`loadFirstInvestmentDate`, one
  spelling of "when did this portfolio start" for both).

The opening point is labelled by the session its close came from
(`openingSessionDate`), on sampled ranges as on daily ones, so it reads as the
previous market close the caption names. The consequence the reader can check:
last point less first point is `investedValueChange`, to the cent.

---

## 11. Money-weighted return of the invested part

Status: **proposed.** Scope from kenlasko/monize#1392, the third reading of the
same caption. Sections 10.1-10.8 stay exactly as they are: `IV(t)`, `K(d)`,
`I(d)`, `investmentPnl` and the daily-chained `investmentReturnPercent` are
unchanged, and INV-PORTRESULT-002 still governs them. This section adds a
SECOND FIGURE to that same measure -- the same flows, the same days, the same
completeness -- answering the question the time-weighted one deliberately does
not.

### 11.1 The question TWR does not answer

A time-weighted return is the manager's figure: it neutralises every capital
flow on purpose, so two readers who bought the same fund on the same days see
the same TWR however differently they sized their purchases. What a reader
usually means by "what did I earn" is the other one: the rate their OWN money
earned, with each purchase, sale and distribution weighted by when it happened.
That is the money-weighted return, and its usual spelling is the XIRR -- the
internal rate of return over dated cash flows, Excel's `XIRR`, myfund.pl's
"stopa zwrotu ważona kapitałem".

The two differ exactly where the reader's timing differs from the market's: pay
more in before a rise and the MWR is above the TWR; pay more in before a fall
and it is below. Neither is a correction of the other, and neither replaces the
existing `totalGainLossPercent` ("Simple Return"), which is a cost-basis ratio
with no time in it at all (section 11.8).

### 11.2 The cash flows

From the INVESTOR's point of view, over `(b, e]`, on the INVESTED part only --
the same `IV`, `K` and `I` of section 10.2, not one component more:

| When | Flow | Why |
| --- | --- | --- |
| `b` | `-IV(b)` | what was already invested is a purchase made on day one |
| each `d` in `(b, e]` | `-capitalIn(d)` | a buy, a share transfer in, an ADD_SHARES |
| each `d` in `(b, e]` | `+capitalOut(d)` | a sale, a share transfer out, a REMOVE_SHARES, a return of capital |
| each `d` in `(b, e]` | `+I(d)` | a dividend, interest, a capital-gain distribution |
| `e` | `+IV(e)` | the position is notionally liquidated at the end |

Deposits, withdrawals, idle cash and a transfer between the reader's own
accounts are in none of them, exactly as for the TWR (INV-PORTRESULT-002): they
are not flows of the invested part. A SPLIT is neither capital nor income here
for the same reason section 10.2 gives, and a REINVEST's `-R(d)` and `+R(d)`
fall on the same day and cancel, so the schedule leaves it out.

The day-`e` flows and `+IV(e)` carry the same date and are therefore one term;
so are the day-`b` flows -- there are none, because the window is `(b, e]` and
`IV(b)` is a close that already holds everything dated `b`.

### 11.3 The figures

- **`investmentMoneyWeightedReturnPercent`** -- the ANNUALISED rate `r`
  solving

  ```
  sum_i  CF_i / (1 + r)^((t_i - b)/365)  =  0
  ```

  as a percentage, actual days over 365 (the XIRR convention). This is the
  primary number: "XIRR" means an annual rate to every reader who has met one,
  and it is what myfund calls "średnioroczna".
- **`investmentMoneyWeightedTotalPercent`** -- `(1 + r)^((e - b)/365) - 1`, as a
  percentage: the same rate expressed over the window rather than over a year,
  carried so a later surface can print "since inception" beside the annual
  figure without re-deriving anything.

  **It is an extrapolation of the rate, not a realised total, and a caption must
  not say otherwise.** Case 6 below is the proof: money returned in full after
  one year of a two-year window earns 12.5% annualised, and the total field then
  reads 26.5625% -- the rate compounded over a window in which the second year
  held nothing. `investmentPnl` is the realised amount; this field is a rate in
  another dress.
- **`investmentMoneyWeightedMethod: "xirr"`** -- named on the wire for the
  reason `PeriodReturnMethod` and `InvestedReturnMethod` are: a later method is
  a new union member rather than a silent change of meaning under one caption.

Both percentages are rounded to `PORTFOLIO_MOVE_PERCENT_DECIMALS`, as every
other ratio in this document is; a percentage is not money and never goes
through `roundMoney`.

### 11.4 The solver

`xirrAnnualRate` (`backend/src/common/time-series/xirr.util.ts`), pure, no
dependency, its own spec. It takes flows already folded per day in integer
ten-thousandths (AGENTS.md, Financial math: money is never accumulated as
floats) with a whole-day offset from `b`, and answers the annual rate as a
fraction or `null`.

- **Bracketed bisection** over `(-0.999999, 10]`: a rate at or below -100% makes
  a discount factor undefined, and a portfolio compounding at more than 1000% a
  year is a data defect rather than a return. No Newton step: a bracketed method
  cannot run away from a root, and a derivative-based one has to be told what to
  do when it does.
- At most **200 iterations**, and a tolerance of **1e-10** on the NPV in
  currency units. Bisection halves the bracket every step, so 200 iterations is
  an upper bound nothing reaches, not a budget the answer depends on.
- **`null` rather than a number** whenever the schedule does not define one
  rate:
  - fewer than two dated flows, or every amount zero -- there is nothing to
    solve;
  - no sign change among the amounts (only purchases, or only proceeds) -- no
    rate exists;
  - the NPV has the same sign at both ends of the bracket -- the root, if any,
    is outside the range a return can be reported over;
  - **several roots.** A refusal, never the first root the search happens to
    land on: a printed "IRR" that depends on which end the bisection started
    from is the #1387 class of defect. Uniqueness is accepted on any of
    three sufficient conditions, and refused otherwise:
    1. the amounts in date order change sign exactly once (every purchase
       before every disposal -- a simple investment, whose NPV is strictly
       decreasing in `r`); or
    2. the CUMULATIVE flow sequence, in date order, changes sign exactly once
       (Norstrom's criterion); or
    3. the NPV, sampled densely across the bracket (1,024 points log-spaced in
       `1 + r`), changes sign exactly once. This is what admits a portfolio
       that LOST money and had a dividend or a sale on the way: its amounts
       change sign several times and its cumulative flow never turns positive,
       so neither count applies, yet the negative rate that clears it is the
       only one. A regular-contribution plan in a drawdown is exactly this
       shape, and without the third condition it read as "undefined".

    A schedule such as `-1000, +2300, -1320` clears at both 10% and 20% a
    year: two crossings, and it is reported as undefined.

### 11.5 Missing data, and the window it refuses to annualise

- **`investedComplete === false` withholds both figures**, with the same
  `investedReasons` the P&L and the TWR carry. The MWR is a second figure of one
  measure, not a second measure: it reads the same `IV`, the same `K`, the same
  `I`, so anything that makes the TWR
  unreportable makes it unreportable too. There is no branch in which one is a
  number and the other silently isn't.
- **A schedule with no defined rate** (11.4) is `null` with the reason
  `mwrUndefined`, added to `PeriodResultReason`. Both figures go, because both
  are `r` in different clothes.
- **A window shorter than 30 days does not get an annual rate.**
  `investmentMoneyWeightedReturnPercent` is `null` with the reason
  `windowTooShort`, and `investmentMoneyWeightedTotalPercent` is still reported.
  A 1% week annualises to 68.0% (case 8) -- a figure that is arithmetically
  correct, reads as a claim about a year, and moves by tens of points on the
  next day's close. The total over the window is the same reader's own money
  weighted the same way, with no extrapolation in it, so it is the honest half
  of the pair and it stays. Thirty days is a boundary, not a discovery: it is
  the shortest window over which the annualisation multiplier is under 13.
- `zeroStart` -- a window in which nothing was ever invested -- has no schedule
  to solve either: both MWR figures are `null` with the reasons already on the
  decision. A window in which nothing was invested and nothing was earned is a
  known zero for the P&L and the TWR (case 1 of section 10.5); the MWR of no
  capital is not zero, it is undefined, and it says so.

`mwrUndefined` and `windowTooShort` are causes of the MWR alone. Neither
withholds `investmentPnl` or `investmentReturnPercent`, neither flips
`investedComplete` (which is about those two), and both print NOTHING at the
surfaces that summarise a withheld period: `periodResultUnknownReason` falls
through to `noBaseline` (there is no price, rate or balance to repair) and
`withheldPeriodCause` returns `null` for them, which is the existing behaviour
of both functions for a reason they do not name.

### 11.6 Truth table

`b`, `e` and the days between them exactly as section 10.4 defines them.

| investedComplete | window `e - b` | schedule | MWR annual | MWR total | reasons |
| --- | --- | --- | --- | --- | --- |
| true | >= 30 days | one rate | number | number | -- |
| true | >= 30 days | no rate, or several | `null` | `null` | `mwrUndefined` |
| true | < 30 days | one rate | `null` | number | `windowTooShort` |
| true | < 30 days | no rate | `null` | `null` | `mwrUndefined` |
| true, `zeroStart` | any | nothing invested | `null` | `null` | `zeroStart` |
| false | any | any | `null` | `null` | the decision's own causes |
| no series | -- | -- | `null` | `null` | `noValueSeries` |

### 11.7 The worked cases

Flat prices unless stated, one currency, `b` the day before the first purchase,
amounts in the reporting currency. Each rate below is the solver's answer to six
decimal places.

1. **One purchase, one year, +10%.** `IV(b) = 1,000`, no flow inside the
   window, `IV(e) = 1,100`, `e - b = 365`. Flows `-1,000 @ b`, `+1,100 @ e`.
   `1,100 / (1+r) = 1,000` -> **r = 10.000000%**, total **10%**. Equal to the
   TWR, as it must be: one flow at each end leaves nothing for the weighting to
   do.
2. **The same over two years.** `e - b = 730`: `(1+r)^2 = 1.1` ->
   **r = 4.880885%**, total **10%**. The TWR is 10% (it is not annualised), so
   the pair reports the same journey at two different cadences, which is why the
   card labels them rather than printing two bare percentages.
3. **A second purchase before the rise.** `IV(b) = 1,000` at `b`; the price is
   flat for a year; on day 365 a second 1,000 is bought; the price then rises
   10%; `IV(e) = 2,200` on day 730. TWR: factor 1 on the purchase day (the buy
   enters the base), 1.1 in the second year -> **+10%** over the window,
   4.880885% a year. MWR: `-1,000 @ 0`, `-1,000 @ 365`, `+2,200 @ 730` ->
   `x^2 + x - 2.2 = 0`, `x = 1.06524758` -> **r = 6.524758%**, total
   **13.475242%**. Higher than the TWR's annual figure, and for the reason the
   tooltip gives: more of the reader's money was invested while the rise
   happened. This is the adversarial case of section 11 -- a solver that
   ignored the dates, or weighted by amount alone, reproduces neither figure.
4. **A dividend halfway.** `IV(b) = 1,000`, price flat, a dividend of 10 (1% of
   the value) on day 365, `IV(e) = 1,000` on day 730. TWR: one factor of
   `(1,000 + 10) / 1,000` -> **+1.000000%** over the window. MWR: `-1,000 @ 0`,
   `+10 @ 365`, `+1,000 @ 730` -> `x^2 - 0.01x - 1 = 0`, `x = 1.00501250` ->
   **r = 0.501250%** a year, total **1.005012%**. The totals are NOT the same
   figure, and the difference is the point: the TWR credits the distribution on
   the day it arrived and stops, while the MWR also credits the reader for
   having had it a year before the end. Four decimal places apart is exactly
   what a half-window distribution is worth.
5. **A late cash deposit.** Case 3 plus 50,000 deposited the day before `e` and
   left uninvested. It is in no `K`, no `I` and no `IV`, so it is in no flow of
   11.2: **r = 6.524758%**, unchanged. (The account-level `valueChange` moves by
   50,000; that is sections 2-5's business.)
6. **Sold in full inside the window.** `IV(b) = 8,000`; on day 365 the lot is
   sold for 9,000; `IV(e) = 0` on day 730; the proceeds sit as cash. Flows
   `-8,000 @ 0`, `+9,000 @ 365`, `0 @ 730` -> **r = 12.500000%**: defined from
   the sale, and the cash afterwards is not a flow (money that stopped being
   invested stops earning, the TWR's case 7). The TOTAL field reads
   `1.125^2 - 1 = 26.5625%`, which is the rate extrapolated over a window whose
   second year held nothing -- see the caption rule in 11.3.
7. **An incomplete price inside the window.** Both figures `null`,
   `investedReasons: ["incompletePrices"]`, exactly as `investmentPnl` and the
   TWR. Never a rate solved over a schedule with a subtotal in it.
8. **A seven-day window.** `IV(b) = 1,000`, `IV(e) = 1,010`, `e - b = 7`. The
   rate exists and is 68.007541% a year; the annual figure is nevertheless
   `null` with `windowTooShort`, and the total, **1.000000%**, is reported.

### 11.8 Where it is read

| Surface | Figure |
| --- | --- |
| Portfolio summary card, "MWR (Money-Weighted)" | `moneyWeightedReturn` since inception, annualised |
| Portfolio summary (REST, LLM summary, MCP payload) | the same, with `moneyWeightedReturnReasons` |
| `GET /net-worth/investments-period-result(s)` | both figures per window, for a future toggle |
| "Portfolio performance" card | NOT shown: a row per window times three figures does not fit its column. The payload carries the fields |

The summary's window is the one section 10.7 already defines -- the day before
the scope's earliest non-VOID investment transaction to `todayYMD()` -- through
the same `getInvestedResultSinceInception`, so the card's TWR and MWR are two
answers over ONE series, ONE capital and income load and ONE rate index. A
portfolio younger than 30 days shows the TWR and `UnknownAmount` for the MWR,
which is the `windowTooShort` rule reaching the reader.

The card's other two figures keep their own captions and are neither of these:
`cagr` is growth of the portfolio value against NET INVESTED, with no dates in
it beyond the first and the last, and `totalGainLossPercent` ("Simple Return")
is `(market value - cost basis) / cost basis`, which has no time in it at all
and jumps whenever a purchase enlarges the denominator. Its tooltip says so, in
the reader's own terms, because a figure that moves when nothing was earned has
to explain itself where it is printed.

### 11.9 Test matrix

| Suite | Case |
| --- | --- |
| `xirr.util.spec.ts` | a single in/out pair equals `(out/in)^(365/days) - 1`; the eight-case schedule set of 11.7; an all-zero schedule, a one-flow schedule and a no-sign-change schedule are `null`; `-1000, +2300, -1320` is `null` (two rates in the bracket) rather than either; a Norstrom-only schedule (two raw sign changes, one cumulative) IS solved; a losing regular-contribution schedule with a dividend and a sale (neither count) IS solved at its negative rate; a rate beyond the bracket is `null`; the solver is a pure function of its input (no ambient date) |
| `invested-period-result.util.spec.ts` | the eight cases of 11.7 with their worked numbers; an incomplete day withholds both MWR figures with the same reasons as the TWR; a 7-day window withholds the annual figure and keeps the total; `zeroStart` withholds both |
| `portfolio-period-results-batch.service.spec.ts` | batch == single on the new fields, preset by preset |
| `portfolio.service.spec.ts` | the summary carries `moneyWeightedReturn` and `moneyWeightedReturnReasons` from the since-inception slice, withholds with the cause, and rounds like the other percentages |
| `PortfolioSummaryCard.test.tsx` | the fourth figure renders; a withheld one renders `UnknownAmount` with the reason; both tooltips carry their copy |

The adversarial case, per `docs/financial-calculation-contract.md` section 8:
case 3. An implementation that returns the TWR under the MWR's caption, or that
solves the rate over undated flows, passes cases 1, 2, 5 and 7 and fails 3, 4
and 6.
