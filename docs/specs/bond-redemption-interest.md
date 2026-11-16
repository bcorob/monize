# Bond redemption: interest, not capital gain

Specification for splitting the cash a bond pays at redemption into returned
principal and interest, and for discount (zero-coupon) instruments in the
engine. Written before the implementation (`docs/financial-calculation-contract.md`
section 9). Country-agnostic engine work plus the Polish adapter; no US adapter.

Requested by the owner on 2026-10-12 after a report in discussion
kenlasko/monize#1650: a US Treasury bill bought at 23,530.00 and redeemed at its
24,000.00 face value shows 470.00 as a capital gain, while for tax purposes it is
interest. The same defect exists for the Polish retail bonds in this branch: a
redemption of EDO at 147.05 per bond (EDO0423) entered as `REDEEM` books 47.05
per bond of capitalised interest as a capital gain.

## 1. Sources

- **United States, discount bills.** IRS Publication 550, "U.S. Treasury Bills,
  Notes, and Bonds", subsection "Treasury bills": the difference between the
  discounted price paid and the face value received at maturity is interest
  income, generally reported when the bill is paid at maturity; it appears on
  Form 1099-INT, box 3. Subsection "Discount on Short-Term Obligations": an
  accrued discount is figured "by using either the ratable accrual method or the
  constant yield method". https://www.irs.gov/publications/p550
- **United States, bill price.** TreasuryDirect, bill price from the discount
  rate: `P = 100 x (1 - d x r / 360)`, `r` the days to maturity.
  https://www.treasurydirect.gov/instit/annceresult/press/preanre/2004/ofcalc6decbill.pdf
- **Poland, early redemption.** The issue letters (e.g. EDO1036, para 26 pt 5,
  `backend/src/bonds/adapters/pl/series/fixtures/edo1036-letter.txt`): "naleznosc
  wyplacona z tytulu przedterminowego wykupu jednej obligacji jest pomniejszana o
  kwote naroslych odsetek, ale nie wyzsza niz 3,00 zl". The fee is taken out of
  the accrued interest. COI1030 para 26 pt 5-6: the first period like EDO (capped
  by the interest, 2.00 zl), from the second period a flat 2.00 zl.
- **Poland, tax.** Ustawa o PIT, art. 30a ust. 1 pkt 2: 19 % flat tax "z odsetek
  i dyskonta od papierow wartosciowych"; secondary sources (PKO BP, the issuer's
  agents) state the tax at an early redemption is computed on the interest less
  the fee. https://lexlege.pl/ustawa-o-podatku-dochodowym-od-osob-fizycznych/art-30a/
  Monize computes no tax (spec `polish-retail-bonds.md` 2.0): it only puts the
  interest in the interest column.

Both jurisdictions agree on the one rule the engine needs: what a bond pays
above the principal it was bought at, at redemption, is interest (or discount,
taxed as interest), net of any early-redemption deduction taken from it.

## 2. The rule (country-agnostic)

For a lot of `q` bonds redeemed on day `d`, the engine returns a **redemption
split**:

| Field | Meaning |
| --- | --- |
| `principal` | the lot's principal base at `d`: `principalAt(terms, d) x q` (face value for a bond issued at par, the issue price for a discount instrument) |
| `grossInterest` | value before any deduction, less `principal` |
| `deduction` | value before deduction, less what is paid (the early-redemption penalty after the floor); 0 at maturity |
| `interest` | `max(0, grossInterest - deduction)` |
| `principalReturned` | `payout - interest` (below `principal` only when a deduction exceeds the interest and no floor stops it) |
| `payout` | the cash: the early-redemption value before maturity, the lot's own cash flows dated on `d` at maturity |

`payout = principalReturned + interest` exactly, every figure rounded per the
terms' rounding rule per bond and then multiplied by `q` (the issuer's order).

- **Before maturity** the redemption must be allowed (`windowRefusal`); a
  refused day returns the refusal, never a split.
- **On the maturity date** the payout is the principal plus the interest of the
  last period (a coupon bond's final coupon, a compounding bond's capitalised
  value, a discount bill's full discount).
- **After maturity** the split is the maturity split (the bond was redeemed on
  the maturity date).
- **Unknown inputs**: a rate that is not known yet makes `grossInterest`,
  `interest`, `payout` and `principalReturned` null (never 0), with the existing
  missing-data refusal; `principal` stays known.

### 2.1 Booking

The split maps onto the existing redemption model
(`docs/specs/redemption-accrued-interest.md`), no schema change:

- `REDEEM` row: `quantity = q`, `price = principalReturned / q`, `commission = 0`;
  its proceeds are `principalReturned`, measured against cost basis as today.
- `accruedInterest = interest`, which writes the linked `INTEREST` companion; the
  one cash row is `principalReturned + interest = payout`.

A lot bought at its principal base (at par, or at the issue price) therefore
shows no capital gain, only interest. A deduction larger than the interest (the
COI flat fee in a short period) shows as a capital loss of the excess, which is
what the holder receives.

### 2.2 Where it is computed

- Engine: `redemptionSplit(lotInput, d)` in `backend/src/bonds/engine/`, beside
  `valueBondLot`, through the same schedule, rate and penalty code (a preview is
  the commit's code).
- API: `GET /bonds/securities/:securityId/redemption-split?date=&quantity=&bondInstrumentId=&accountId=[&excludeTransactionId=]`
  for the caller's bond-linked security (another user's or an unlinked one is
  404). `accountId` is required, as for `series-holdings`: lots are held per
  account. `quantity` is a positive whole number (`ParseBondQuantityPipe`, at
  most `MAX_REDEMPTION_QUANTITY`). The lots redeemed are the ones
  the removal resolves to: the ledger rows up to `date` (without
  `excludeTransactionId`, the row being edited) are folded by
  `bondLotsFromTransactions` with and without a REDEEM of that series appended,
  and the lots the removal takes are the difference, so the first-in first-out
  choice is the write guard's own (`BondHoldingsService.redemptionSplit`). Each
  portion goes through `redemptionSplit`, and the figures are summed exactly (a
  figure is null when any portion's is unknown; `refusal` is the first
  portion's). The answer is
  `{ date, quantity, principal, grossInterest, deduction, interest, principalReturned, payout, refusal }`,
  decimal strings or null; `refusal` is a window refusal (`NOT_REDEEMABLE`,
  `TOO_EARLY`, `TOO_LATE`, `RECORD_DAY`, `TERMS_INCOMPLETE`), `RATE_UNKNOWN` or
  `PURCHASE_OUTSIDE_SALE_WINDOW`, never `MATURED` (a matured lot pays the maturity
  split). A quantity above what the account holds of the series is 400 with
  `errorCode` `REMOVAL_EXCEEDS_SERIES` (the write's refusal), a ledger whose
  lots cannot be derived before the removal is 422.
- Form: on `REDEEM` of a bond-linked security, once series, date and quantity are
  set, the form asks the endpoint (debounced, an answer to an earlier request is
  dropped), fills `price` (`principalReturned / quantity`) and `accruedInterest`
  (`interest`) and shows the interest, the deduction and the payout as
  information. A field the person has edited is not overwritten, and an existing
  redemption keeps its stored values on open (only a change of series, date,
  account or quantity suggests new ones); the fill is a suggestion, not a server
  override.

## 3. Discount instruments in the engine

A rate rule and a schedule for discount instruments, for any adapter (none
installed uses them yet; `docs/backend/bond-adapters.md` section 7 maps US
Treasury bills onto them):

- `rateRule: { type: "ZERO_COUPON_DISCOUNT" }`, the series terms carrying
  `instrument.issuePrice` (per face value, exact decimal) next to `faceValue`.
- `schedule: { anchor: "ISSUE_DATE", issueDate, maturityDate, periodCount: 1 }`:
  one period from the issue date to the maturity date, in days.
- `principalAt(terms, d) = issuePrice` for every `d` in the period; the value on
  day `k` of `N` is `issuePrice + (faceValue - issuePrice) x k / N` (the ratable
  accrual method of IRS Publication 550), rounded per the terms; on the maturity
  date it is `faceValue`.
- `capitalization: NONE`, `redemption: MATURITY_ONLY` (a bill is sold, not
  redeemed early; a sale before maturity is out of scope, section 5).

### 3.1 Numerical examples

| Case | Inputs | principal | grossInterest | deduction | interest | principalReturned | payout |
| --- | --- | --- | --- | --- | --- | --- | --- |
| US bill held to maturity | one bill, face 24,000.00, issue price 23,530.00, `q` 1 | 23,530.00 | 470.00 | 0 | 470.00 | 23,530.00 | 24,000.00 |
| Same bill, half way (value only, no split) | day 13 of 26 | 23,530.00 | 235.00 | n/a | n/a | n/a | value 23,765.00 |
| Same money as 240 units of face 100 | issue price 98.041667, `q` 240, 2 decimals per unit | 23,529.60 | 470.40 | 0 | 470.40 | 23,529.60 | 24,000.00 |
| EDO0423 at maturity | 147.05 per bond (Ministry), `q` 1 | 100.00 | 47.05 | 0 | 47.05 | 100.00 | 147.05 |
| EDO early, interest above the fee | accrued 10.20, fee 3.00, floor face | 100.00 | 10.20 | 3.00 | 7.20 | 100.00 | 107.20 |
| EDO early, interest below the fee | accrued 1.50, fee 3.00, floor face | 100.00 | 1.50 | 1.50 | 0.00 | 100.00 | 100.00 |
| COI early, period 2 | accrued 1.20, flat fee 2.00, no floor | 100.00 | 1.20 | 2.00 | 0.00 | 99.20 | 99.20 |

The "240 units" row is the per-bond rounding of section 2 at work: an issuer
that prices a unit to six decimals and rounds only the holding (as Treasury
auctions do) is modelled as one unit of the whole face value, or with
`moneyDecimals` the issuer uses; that choice belongs to the adapter that
defines such a series, not to the engine.

## 4. Invariants

- INV-BOND-009: a bond-linked redemption's split satisfies
  `payout = principalReturned + interest`, `interest >= 0`, and
  `principalReturned <= principal`; at maturity `deduction = 0`. Enforced by the
  engine's unit and golden tests.
- The suggestion the form shows is the split of the same lots the write guard
  removes (INV-BOND-007): the endpoint resolves them through the same code.
- INV-BOND-008 is unchanged: the split reads stored terms and observations only;
  it fetches nothing.

## 5. Out of scope

- A sale before maturity on a secondary market (accrued discount versus capital
  gain, market discount): a separate spec.
- A "discount instrument" flag for a security the engine does not price: a
  separate change outside the engine.
- A US adapter (series fetch, Treasury bills as programs).
- Tax computation of any country.

## 6. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Split | unit | every row of 3.1; refusal outside the window; unknown rate -> nulls; after maturity = maturity split; per-bond rounding then `x q` |
| Discount rule | unit | terms parse and refuse (`issuePrice` missing or above face); ratable value on day 0, k, N; maturity value = face; `MATURITY_ONLY` |
| Polish golden | golden | EDO0423 maturity split; an EDO and a COI early redemption from the letters' annex formula |
| Endpoint | unit, integration | owner-scoped (another user's security 404), FIFO lots across two purchase dates, quantity above the holding refused |
| Form | unit | fills price and accrued interest on REDEEM of a linked bond, shows the deduction, keeps a person's edit, non-bond REDEEM unchanged |
