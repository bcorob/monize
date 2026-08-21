# Redemption Accrued Interest

Approved specification for recording the accrued interest a CD or bond pays out
when it is redeemed, as part of the redemption itself rather than as a sibling
leg of a split transaction in the cash ledger. Written before the implementation,
per `docs/financial-calculation-contract.md` section 9. Resolves the defect where
a Microsoft Money "Redeem CD/Bond" (`act` 30) imports as a split whose investment
leg shows only the principal, with no way to enter accrued interest by hand.

## 1. The model

No schema change. A redemption carrying accrued interest is **two rows**:

| Row | Action | `total_amount` | `transaction_id` | `linked_transaction_id` |
| --- | --- | --- | --- | --- |
| The redemption | `REDEEM` | `quantity x price - commission` (proceeds) | the one cash row | the companion |
| The companion | `INTEREST` | the accrued interest | `null` | the redemption |

- The **companion** is an ordinary `INTEREST` investment transaction on the same
  account, security and date. It is what makes the interest reportable as
  interest income with no special case in any report.
- Exactly **one** cash transaction exists for the pair, owned by the redemption
  row, for `proceeds + accrued interest` converted at the redemption's stored
  rate. The companion writes no cash row of its own, so the amount is not
  counted twice.
- `linked_transaction_id` already links `TRANSFER_IN`/`TRANSFER_OUT` legs. This
  is its second use, and the two are told apart by action, not by a flag: a
  linked `INTEREST` row whose partner is a `REDEEM` is an accrued-interest
  companion. `isAccruedInterestCompanion` is that predicate, written once.
- Accrued interest is an input on the redemption; `accruedInterest` on the API
  and on the read model is **derived** from the companion's `total_amount`, and
  is `0` when there is no companion.

### 1.1 Why the interest is not folded into `total_amount`

`total_amount` on a disposal is proceeds, and every realized-gain fold measures
proceeds against cost basis (`portfolio-calculation.service.ts`,
`investment-report-data.service.ts`). Accrued interest is income, not proceeds:
folding it in would report it as capital gain, in the gain columns, on the tax
surface the reporter is trying to get right. The combined figure is derived for
display and for the cash row, and is stored in neither row's `total_amount`.

### 1.2 Scope

`REDEEM` only in Monize's stored model and public API. Real Money Plus data has
two encodings for a register activity displayed as "Redeem CD/Bond": `act` 30,
and `act` 2 (`SELL`) with positive `TRN_INV.amtInt` and a principal-plus-interest
cash split. The importer normalizes the measured SELL-shaped variant to REDEEM;
it does not broaden the API to accept accrued interest on a native SELL.
Accrued interest on any other action is refused (section 2, invariant 6).

## 2. Invariants

1. **One redemption, one cash row.** The pair produces exactly one cash
   transaction, for `roundMoney(proceeds + accruedInterest) x exchangeRate`. No
   parent split is required, and none is created.
2. **The cash row is no longer `|total_amount| x rate`.** That equality held for
   every investment row before this change and is what several call sites
   assumed. For a redemption the cash amount comes from `disposalCashAmount`,
   which is the only place proceeds and accrued interest are added.
3. **Proceeds stay proceeds.** `REDEEM.total_amount` excludes accrued interest,
   so cost basis, realized gain and capital-gains reporting are unchanged by
   this feature. A test asserts the gain for a redemption with interest equals
   the gain for the same redemption without it.
4. **Two rows, one event, one status.** The companion is created with the
   redemption's status, follows it across the VOID boundary, and is deleted with
   it. A VOID redemption's companion is VOID and moves no cash.
5. **The companion is not independently mutable.** It is materialized from the
   redemption's `accruedInterest`; editing or deleting it directly is refused
   with a pointer at the redemption, the same shape as the split-embedded status
   refusal. Deleting the redemption still deletes the pair.
6. **Accrued interest is refused where it cannot be honoured.** A non-`REDEEM`
   action, a negative value, or an embedded split row (`transaction_split_id`
   set, where the parent split leg is already the cash side) is a
   `BadRequestException` raised *before* any write, inside the transaction.
7. **Zero is absent, not a companion.** `accruedInterest` of `0` or omitted
   writes no companion row. Setting an existing redemption's accrued interest to
   `0` deletes the companion; raising it from `0` creates one.
8. **The interest is counted exactly once as income.** The companion is a normal
   `INTEREST` row for every income fold. Nothing adds `accruedInterest` to income
   separately.
9. **The register shows one row for one event.** `findAll` excludes a companion
   from both the page and the count -- server-side, so pagination cannot split a
   pair and show it once -- and the redemption's row displays
   `redemptionTotalWithInterest`, which is what the cash account received. Every
   other reader (security history, the LLM row lists, reports) sees the companion
   as the ordinary `INTEREST` row it is.

## 3. Truth table

A redemption of 10 units at 1,000.00, commission 25.00, accrued interest 87.50.
Proceeds are 9,975.00; the cash row is 10,062.50.

| Case | REDEEM `total_amount` | Companion | Cash rows | Cash balance | Holdings |
| --- | --- | --- | --- | --- | --- |
| Accrued interest 87.50 | 9,975.00 | 87.50 | 1, for 10,062.50 | +10,062.50 | -10 units |
| Accrued interest 0 | 9,975.00 | none | 1, for 9,975.00 | +9,975.00 | -10 units |
| Status VOID | 9,975.00 | 87.50, VOID | 1, VOID | unchanged | unchanged |
| Future-dated | 9,975.00 | 87.50 | 1, for 10,062.50 | deferred to the cron | unchanged |
| Cash account in another currency, rate 1.35 | 9,975.00 | 87.50 | 1, for 13,584.38 | +13,584.38 | -10 units |
| Edit: interest 87.50 -> 0 | 9,975.00 | deleted | 1, re-amounted to 9,975.00 | -87.50 | unchanged |
| Edit: interest 0 -> 87.50 | 9,975.00 | created | 1, re-amounted to 10,062.50 | +87.50 | unchanged |
| Delete the redemption | -- | deleted | deleted | -10,062.50 | +10 units |
| Embedded in a split | refused | -- | -- | unchanged | unchanged |

The cross-currency row is `roundMoney(9,975.00 + 87.50) x 1.35 = 13,584.375`,
rounded to the cash currency's `decimalPlaces` (2) by
`createCashTransactionInTransaction`, giving 13,584.38. The conversion applies to
the combined figure, not to each component separately, so no sub-cent residue is
introduced twice.

## 4. Missing data

- Accrued interest is never inferred. Absent means zero interest was paid, which
  is a known state, not an unknown one -- there is no `null` accrued interest.
- A redemption whose cash account currency differs from the security's and whose
  rate cannot be resolved is refused by the existing
  `resolveCashExchangeRate`. The accrued interest does not get a second rate, a
  default of 1, or a separate resolution: one event settles at one rate.
- A companion pointing at a redemption that no longer exists is a corrupted pair,
  not an interest payment. Readers resolve the companion from the redemption,
  never the reverse.

## 5. Microsoft Money import

`TRN_INV.amtInt` is the accrued interest and is already parsed as
`MnyInvestmentDetail.interest` by `backend/src/import/mny/tables/read-investments.ts`;
today `indexDetails` in `backend/src/import/mny/map/map-investments.ts` drops it.

1. For `act` 30, `TRN.amt` is Money's gross cash figure and carries the accrued
   interest, so the redemption's `total_amount` is `TRN.amt - amtInt`. For the
   SELL-shaped variant, `TRN.amt` is already proceeds and must not have
   `amtInt` subtracted again. In both shapes the companion carries `amtInt`.
2. Money records the payout as a two-leg split in the cash account: the
   investment leg and an interest leg. That split is collapsed into the single
   cash row **only** when the parent has exactly two legs, one of them the
   investment leg, and the sibling leg's amount equals `amtInt`. Any other
   shape keeps today's split fidelity untouched -- a split that means something
   else must not be rewritten because one leg happened to be a redemption. In
   that non-collapse shape, the preserved sibling remains the interest record;
   the generated companion and its redemption back-link are discarded after
   cash-source mapping so income is not counted twice and an embedded row does
   not carry a state the write API refuses.
3. `act` 30 maps directly to `REDEEM`. `act` 2 maps to `REDEEM` only when its
   investment detail carries positive `amtInt`; an ordinary SELL remains SELL.
   The regression matrix includes the real Money Plus shape: proceeds 5,134.09,
   interest 5.43 and a split parent payout of 5,139.52.
4. `REDEEM_CD_BOND` stays in `MNY_UNCONFIRMED_ACTIONS`: its `TRN_INV` shape is
   now measured against one reporter's file, but its lot behaviour is not.

## 6. Required tests

Per `docs/verification-contract.md` and the adversarial list in
`docs/testing-contract.md`:

| Kind | Case |
| --- | --- |
| Unit | `disposalCashAmount` over the section 3 rows, including 4dp rounding of the sum before conversion |
| Unit | `isAccruedInterestCompanion` distinguishes a companion from a transfer leg and from a free-standing `INTEREST` row |
| Guard (source scan) | no hand-rolled `proceeds + interest` addition outside `accrued-interest.util.ts` |
| Service | create with and without interest; the cash row amount and the account balance |
| Service | edit raising, lowering, removing and adding accrued interest, asserting the balance delta each time |
| Service | deleting the redemption removes companion and cash row and reverses exactly the combined amount once; deleting the companion directly is refused before mutation |
| Service | VOID redemption creates a VOID companion and moves no balance; un-voiding moves the combined amount |
| Service | future-dated redemption defers the balance but writes the cash row |
| Service | cross-currency redemption converts the combined figure at one rate |
| Service | refusal: non-REDEEM action, negative value, embedded split row |
| Financial | realized gain for a redemption with interest equals the gain without it (invariant 3) |
| Financial | the interest appears exactly once in dividend/interest income |
| Import | `act` 30 persists as `REDEEM` (writer level) |
| Import | `amtInt` becomes the companion and `TRN.amt - amtInt` the proceeds |
| Import | a two-leg split matching `amtInt` collapses; a three-leg split, or a two-leg split whose sibling does not match, stays intact and has no generated companion or back-link |
| Frontend | the ledger renders one row for the pair, with the combined total |
| Frontend | the accrued-interest input appears for REDEEM and for no other action |
| Frontend | `redemptionTotalWithInterest` treats an absent field as no interest, so a page served by an older backend still renders |

## 7. Out of scope

- Backfilling redemptions already imported as split legs. Re-importing is the
  fix; no migration touches existing financial data.
- Accepting accrued interest on a native Monize `SELL` API request (section 1.2).
- Accrued interest inside an embedded investment split (invariant 6).
- The QIF/CSV import path: Money's QIF export has no redeem action.
