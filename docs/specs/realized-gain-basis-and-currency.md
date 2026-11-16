# Spec: realized and capital gains, unknown basis and mixed currency

Governs: issue #1859, the remaining gaps after the audit change that made
`calculateRealizedGains` report `costBasis` / `realizedGain` as `null` when a
position holds shares added with no cost.

Read first: `docs/financial-calculation-contract.md` sections 1 and 2,
`docs/financial-semantics.md` ("Average cost, not FIFO", "A transfer carries
the basis the source released"), `docs/specs/return-of-capital.md`.

Invariants touched: INV-FX-001 (a rate for a date is bounded, never 1:1),
INV-FX-002 (a row's own rate converts it; the market rate on its own date is the
fallback), INV-TRADE-001 (`acquisitionCost` keeps the executed total as the
fact). No new invariant ID: the rules below refine the realized-gain half of
`docs/financial-calculation-contract.md` section 2.

## 1. The four defects

1. **Capital gains by period.** `applyTxToState` and the period loop of
   `calculateCapitalGainsForPeriods` send `ADD_SHARES` / `REMOVE_SHARES` to
   `default`, so the by-period report states a realized gain against a basis
   that lacks those shares.
2. **Mixed basis currency.** A row's `exchangeRate` converts the security
   currency into the **settlement** account's currency, which is not always the
   holding account's. A CAD brokerage holding a USD security, bought from a USD
   chequing account (rate 1) and sold into CAD (rate 1.35), subtracted USD from
   CAD.
3. **Security detail card.** The API returns `realizedGainKnownSubtotal`; the
   card showed only the unknown marker.
4. **Three replays.** `calculateRealizedGains`, the period loop and
   `calculateCostBasisLotsInAccountCurrency` each kept their own bookkeeping, so
   a rule fixed in one (an unpriced lot, a return of capital) was missing in
   another.

## 2. Invariants

1. **One replay.** `replayPositionBasis`
   (`backend/src/securities/position-basis-replay.ts`) is the only fold of a
   position's basis. The lots replay, `calculateRealizedGains` and the
   by-period report read its per-row result; none keeps a basis of its own. It is
   built on `applyActionToQuantity`, `acquisitionCost`, `applyReturnOfCapital`
   and `returnOfCapitalAmount`.
2. **A basis is in one currency or it is unknown.** No amount in one currency is
   added to, or subtracted from, an amount in another. A figure is converted
   first, or the result is `null` with the reason `mixed_basis_currency`.
3. **A conversion uses the row's own rate where the row has one** (INV-FX-002):
   - the target is the security's currency: the row's native amount
     (`quantity * price + commission`, or the executed total) is exact and needs
     no rate;
   - the target is the settlement currency: the row's `exchangeRate` applies;
   - any other pair: the market rate on the row's own date through
     `ExchangeRateService.resolveStoredRate` in `historical` mode, which is
     `resolveFxRate` (INV-FX-001): never a later rate, never an unboundedly old
     one. No rate means unknown, never 1.
4. **Shares of unknown cost make every figure drawn on them unknown.**
   `ADD_SHARES` / `REMOVE_SHARES` with a non-zero quantity, an unpriced
   acquisition, an unconvertible return of capital and an unresolved transfer
   mark the position's basis unknown until the position closes to zero. A
   disposal drawn on an unknown basis has `costBasis` and `realizedGain` of
   `null`; its proceeds stay known.
5. **A subtotal is not a total.** Where a total is `null` the known part goes in
   its own field (`realizedGainKnownSubtotal`) beside a flag
   (`realizedGainComplete`, read as `=== false`).
6. **Zero is not unknown.** A security never sold has a realized gain of `0` and
   `realizedGainComplete` true. A position that closed carries a known zero
   basis into the next purchase.
7. **The proceeds and the basis share a currency, the holding account's.** A
   disposal settled in another currency is converted by rule 3 first.

## 3. Truth tables

### 3.1 Realized gain of one disposal

| Basis history | Proceeds currency | Result |
| --- | --- | --- |
| all priced, same currency as the report | the report's | complete gain |
| holds an `ADD_SHARES` / `REMOVE_SHARES` lot | any | gain `null`, reason `quantity_only_action`, proceeds known |
| holds an unpriced acquisition | any | gain `null`, reason `unpriced_acquisition` |
| a basis row converts by rule 3 | the report's | complete gain in the report's currency |
| a basis row has no usable rate | any | gain `null`, reason `mixed_basis_currency` |
| all priced | not the report's, no rate | gain `null`, reason `mixed_basis_currency` |
| position closed to zero since the unknown lot | any | the next purchase is a known basis |

### 3.2 Realized gain of a period

| Disposals in the period | `realizedGain` | `realizedGainComplete` | `realizedGainKnownSubtotal` |
| --- | --- | --- | --- |
| none | `0` | true | `null` |
| all on a known basis | their sum | true | `null` |
| some on an unknown basis | `null` | false | the sum over the known ones |
| all on an unknown basis | `null` | false | `0` |

A period that moves shares with `ADD_SHARES` / `REMOVE_SHARES` also reports
`totalCapitalGain` and `unrealizedGain` as `null`: the value change includes
shares that arrived or left with no cost or proceeds, so `endValue - startValue
+ sells - buys` is not a gain.

## 4. Numerical examples

| # | History (CAD brokerage unless stated) | Before | After |
| --- | --- | --- | --- |
| 1 | `ADD_SHARES` 100 (no price), `BUY` 100 @ 50, `SELL` 100 @ 60 (6,000) | by period: realized 3,500, no flag | by period: realized `null`, complete false, known subtotal 0; per sale: cost `null`, gain `null`, proceeds 6,000 |
| 2 | as 1, then `SELL` the other 100 for 6,000 | | the position closed; both sales unknown; a later `BUY` 10 @ 100 and `SELL` 10 @ 110 is known: gain 100 |
| 3 | USD security. `BUY` 10 @ 100 from USD chequing (rate 1, 1,000 USD). `SELL` 10 @ 110 into CAD at 1.35 (1,485 CAD). Market USD to CAD on the buy date 1.35 | gain 485 (1,485 less 1,000 USD) | basis 1,350 CAD, gain 135 |
| 4 | as 3 with the buy-date rate 1.30 | 485 | basis 1,300, gain 185 (135 on the security, 50 on the rate) |
| 5 | as 3 with no USD to CAD rate on or before the buy date (within `FX_MAX_RATE_AGE_DAYS`) | 485 | cost `null`, gain `null`, reason `mixed_basis_currency`, proceeds 1,485 |
| 6 | USD brokerage, USD security. `BUY` 10 @ 100 from CAD chequing at 1.35 (1,350 CAD). `SELL` 10 @ 110 into USD (rate 1) | 1,100 less 1,350 = loss 250 | basis 1,000 USD (native amount, no rate), gain 100 |
| 7 | `BUY` 10 @ 100 plus 10 commission, `SELL` 10 @ 110 | | basis 1,010 in realized gains, lots replay and by period alike; gain 90 |

## 5. Missing-data policy

- An unknown basis is reported as `null` with a reason; the reason is the
  replay's `ReplayedBasisGap`, carried on the realized-gain row as `basisGap`
  (new, `null` when the basis is known).
- An unconvertible proceeds figure leaves the amount as the sale settled it, in
  the sale's settlement currency; the gain is `null`. The entry carries no
  currency of its own for it. Recorded limit.
- Every surface that adds gains (security detail, the investment detail YTD
  figure, the realized-gains report, the LLM and MCP capital-gains roll-up)
  already treats `null` as unknown; the roll-up gains `realizedGainComplete`
  and `realizedGainKnownSubtotal` on its totals and entries.
- The investment report's `realizedGains` column (native currency, its own
  fold in `investment-report-data.service.ts`) reports `null` when a disposal
  drew on an unknown basis.
- **Residual kept, not decided here.** A `TRANSFER_IN` whose paired leg cannot
  be used (leg outside the rows, source unknown, two currencies) is priced from
  its own row in the realized-gain and by-period reports, and is unknown in the
  lots replay. The shared replay takes this as an option so neither answer
  changes; unifying them is a separate decision.

## 6. Test matrix

| Test | Fails on the old code because |
| --- | --- |
| realized gains: examples 1 and 2 | (1 already null; kept as the regression pin) |
| by period: `ADD_SHARES` + `BUY` + `SELL` in one period and across periods | realized 3,500 with no flag |
| by period: `REMOVE_SHARES` | the share count moved with no flag |
| by period: examples 3, 5 and 6 | `buys` / `sells` in the settlement currency |
| realized gains: examples 3 to 6 | USD subtracted from CAD |
| parity: one history through the lots replay, realized gains and by period gives one basis (commission included, return of capital, partial sale) | three folds |
| lots replay: all existing cases unchanged | |
| security detail card: known subtotal shown relabelled as partial | the card showed only the marker |
| LLM roll-up: `realizedGainComplete`, `realizedGainKnownSubtotal` | fields absent |
| investment report: `realizedGains` null after `ADD_SHARES` then `SELL` | confident figure |
