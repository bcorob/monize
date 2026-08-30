# Financial Semantics

What the numbers mean: signs, legs, rate direction, precision, and the exact
arithmetic each derived figure is defined by. This is the narrow reference that
`docs/financial-calculation-contract.md` and `docs/time-series-contract.md`
assume. Those two own missing-data propagation, the cost-basis/tax truth table,
materialized-result versioning, adjusted-versus-raw prices and period
boundaries; none of that is repeated here. Root `CLAUDE.md` states the
`decimal(20,4)` and `roundFxRate` rules at a glance -- this document gives the
full field table and the call sites.

It exists because a semantic that lives in three places drifts in two of them.
Every gap in section 10 is a place where two code paths currently answer the same
question differently, and each was found by reading the paths side by side
rather than by either one failing a test.

## 1. Signs

`transactions.amount` is a single signed `decimal(20,4)`. There is no debit/credit
column and no type flag:

```text
positive  = money entering the account (income)
negative  = money leaving the account (expense)
```

The sign is supplied by the caller and validated only for range and precision.
No server rule requires an income category to carry a positive amount, so the
category and the sign can disagree; code that needs to know direction must read
the sign, not the category.

For transfers the sign is structural rather than caller-supplied. The DTO's
`amount` must be non-negative, and `createTransfer` writes the source leg as
`-amount` and the destination leg as `+toAmount`. Consequently **the sign is
what identifies a leg**, and the transfer service re-derives it repeatedly:

```typescript
const isFromTransaction = Number(transaction.amount) < 0;
```

There is no stored "this is the source leg" flag. A change that could make a
source leg non-negative breaks leg identification everywhere at once.

For a foreign-currency entry, `normalizeFxEntry` requires `originalAmount` and
`amount` to share a sign (either may be exactly zero).

## 2. Transfers

A transfer is **two linked `transactions` rows**, each pointing at the other via
`linkedTransactionId` -- not one row with two accounts. A transfer that is one
leg of a split is different again: it links through
`transaction_splits.linkedTransactionId`, and the counterpart's
`linkedTransactionId` points at the split *parent*, not at a mirror leg. That is
why the split-transfer paths are separate code from the plain pair throughout
`transaction-transfer.service.ts`, and why a fix to one has repeatedly missed
the other.

`toAmount` is:

```text
toAmount = explicit toAmount, if supplied
         = roundMoney(amount * exchangeRate), otherwise
```

An explicitly supplied `toAmount` wins outright. **Nothing cross-checks it
against `amount * exchangeRate`**, at any tolerance -- a client may state a
destination amount arbitrarily far from the rate-implied one and it is stored as
given. If a tolerance is wanted, it does not exist yet; do not write code that
assumes one.

### Status must move on both legs or neither

A transfer's two legs are one economic fact. Setting one leg to `VOID` while the
other stays active makes money exist in one account and not the other: a 100.00
transfer whose source leg alone is voided restores the source balance and leaves
the destination credited, so 1,000.00 held across two accounts reads as 1,100.00.

```text
FIN-001
Any write that changes a transfer leg's `status`, or that moves a balance on the
strength of a status, must apply to both legs in the same transaction, or to
neither.
```

## 3. Exchange rates

**Direction.** `exchangeRate` is *account-currency units per one unit of
`originalCurrencyCode`* -- the account currency is the quote, the foreign
currency is the base:

```text
amount ~= roundMoney(originalAmount * exchangeRate)

Source: 100.00 USD in a CAD account
Rate:   1.3500 CAD per USD
Stored: originalAmount 100.00, originalCurrencyCode USD, exchangeRate 1.3500,
        amount 135.00
```

**Precision.** A rate is not money. `roundFxRate` rounds to
`FX_RATE_DECIMALS = 10`, matching the `NUMERIC(20,10)` columns; display uses
`FX_RATE_DISPLAY_DECIMALS = 6`. `roundMoney(1 / 1.3652)` gives `0.7325`, which
inverts back to `1.3661` -- four decimal places on a rate is a reconciliation
error, not a rounding preference.

**Conversion.** `applyFxConversion` folds the account's `fxFeePercent` in as a
cost, always reducing the magnitude:

```typescript
const base = roundMoney(originalAmount * rate);
const fee = fxFeePercent && fxFeePercent > 0
  ? -roundMoney((Math.abs(base) * fxFeePercent) / 100)
  : 0;
return { base, fee, amount: roundMoney(base + fee) };
```

No separate fee row is written; the Foreign Currency Fees report derives the fee
back out of `(originalAmount, exchangeRate, amount)`. That derivation is the
reason all three must stay mutually consistent on every write.

**Validation.** `normalizeFxEntry(input, accountCurrencyCode)` is shared by
transactions and scheduled transactions so both accept and reject exactly the
same shapes:

| Input | Result |
| --- | --- |
| Neither `originalAmount` nor `originalCurrencyCode` | Both `null` -- an ordinary entry |
| Exactly one of the pair | Rejected, `fxFieldsIncomplete` |
| `originalCurrencyCode` equals the account currency | Stripped to both `null`, tolerated |
| A foreign pair with no `exchangeRate`, or one `<= 0` | Rejected, `fxRateRequired` |
| `originalAmount` and `amount` with opposite signs | Rejected, `fxSignMismatch` |

### A missing rate is not a rate of 1

```text
FIN-002
An unavailable exchange rate makes the converted value unknown. It must
propagate as unknown. It may never be replaced by 1, and an unconvertible amount
may never be returned under the target currency's label.
```

The two forms this violation takes, both present today, are worth naming
because neither looks wrong locally:

```typescript
rate = reverseRate !== null ? 1 / reverseRate : 1;   // an else-branch of 1
return result ?? amount;                             // the unconverted amount, relabelled
```

The first reports a USD position in CAD at par. The second returns the USD
figure under a CAD heading, which is worse than an error because it is
plausible. `docs/financial-calculation-contract.md` section 1 governs what to
return instead.

## 4. Precision by field

Money is `decimal(20,4)`. Everything below is a deliberate exception; a value
whose column is wider must not be rounded to money precision on the way in.

| Field | Precision | Note |
| --- | --- | --- |
| `transactions.amount`, `transaction_splits.amount`, `accounts.opening_balance`, `accounts.current_balance`, budget amounts, `investment_transactions.total_amount`, `investment_transactions.commission` | `NUMERIC(20,4)` | money |
| `exchange_rates.rate` and every `exchange_rate` column that mirrors it | `NUMERIC(20,10)` | round with `roundFxRate`, display at 6dp |
| `investment_transactions.quantity`, `holdings.quantity`, `scheduled_transactions.investment_quantity` | `NUMERIC(20,8)` | share counts -- and the SPLIT ratio, see section 6 |
| `investment_transactions.price`, `holdings.average_cost`, `security_prices.{open,high,low,close,adjusted_close}_price`, `scheduled_transactions.investment_price` | `NUMERIC(24,10)` | per-share prices are wider than money |
| `accounts.interest_rate`, `accounts.fx_fee_percent` | `NUMERIC(8,4)` | percentages |
| Monte Carlo rate inputs | `NUMERIC(8,6)` | |

The MS Money importer narrows investment values to 6dp price / 8dp quantity
before writing. That is an importer choice about source fidelity, not the
storage precision, and it is the one place the two legitimately differ.

## 5. Splits

`validateSplitAmountSum` requires at least two splits (unless a single
transfer/investment pass-through) and that the children sum exactly to the
parent at full money precision:

```typescript
const roundedSum = sumMoney(splits.map((s) => Number(s.amount)));
const roundedAmount = roundMoney(Number(transactionAmount));
if (roundedSum !== roundedAmount) throw new BadRequestException(...);
```

`sumMoney` accumulates in integer ten-thousandths rather than adding floats, so
the canonical case sums exactly:

```text
-3.3333 - 3.3333 - 3.3334 = -10.0000
```

Note what makes this work: the comparison happens at 4dp, the storage
precision. Rounding to cents before comparing -- which a currency input is
tempted to do -- makes three amounts that do not sum appear to.

## 6. Investments

### Cost basis includes acquisition commission

```text
Buy: 10 shares at 20.00, commission 5.00
Total basis:     205.00
Basis per share:  20.50
```

`total_amount` is `quantity * price + commission` for a BUY and
`quantity * price - commission` for a SELL, so a sell's commission reduces
proceeds. Cash impact mirrors this exactly: `-(qp + c)` on a buy, `qp - c` on a
sell.

A zero or absent price must not be treated as a free acquisition;
`portfolio-calculation.service.ts` guards this explicitly, and
`docs/financial-calculation-contract.md` section 2 has the truth table.

### Average cost, not FIFO

A SELL draws basis down proportionally at the running average cost per share:

```typescript
const sellQty = Math.min(quantity, entry.quantity);
const avgCostPerShare = entry.quantity > 0 ? entry.costBasis / entry.quantity : 0;
const costBasisSold = sellQty * avgCostPerShare;
const realizedGain = proceeds - costBasisSold;
```

### A SPLIT multiplies

```text
FIN-003
A SPLIT scales the running share count by its ratio and scales per-share cost by
its reciprocal, preserving total basis. It never adds the ratio to the share
count, and it is never grouped with BUY, REINVEST or TRANSFER_IN.

Starting quantity: 90 shares
Split ratio:       2.0
Correct result:    180 shares
Additive result:    92 shares   (a difference of -88 shares)
```

The ratio is stored in the `quantity` column of the `SPLIT` investment
transaction, validated only as `> 0`. A reverse split is the same operation with
a ratio below one -- `reverseSplit(ratio)` is literally
`applySplit(1 / ratio)`, and a 1-for-2 reverse split is `ratio = 0.5`, halving
shares and doubling per-share cost. There is no separate reverse-split action,
so any code that special-cases "ratio greater than one" is wrong for half the
inputs.

`holdings.service.ts` implements this correctly (`qty *= txQty`). Section 9
records where it is implemented additively instead.

## 7. Scheduled occurrences

An occurrence may carry an override. `scheduled_transaction_overrides` is unique
on `(scheduled_transaction_id, original_date)`
(`uq_sched_txn_overrides_occurrence`, migration 168), so one occurrence has at
most one override.

That constraint used to name `override_date`, and the sentence above was drawn
from it as if the two were interchangeable -- they are not, and the conclusion
was false in both directions. `original_date` is the occurrence's identity;
`override_date` is where the override moved it. Keyed on the latter, two
overrides could replace one slot (the reader kept whichever row came first, so
row order chose the amount, category and date a posting used) while two genuinely
different occurrences could not be moved onto the same day. `createOverride`'s
SELECT-then-INSERT was the only thing between the API and the first state, and a
SELECT is not a lock.

```text
FIN-004
A stored override price is a decision the user made about that occurrence.
Reopening the editor must not replace it with the current market price. Applying
a fresh quote is an explicit action, never a side effect of opening a dialog.
```

Ten shares stored at 100.00 that come back as ten at 120.00 -- with the total
silently recomputed -- is a money field changed by nobody, and the user has no
way to tell it happened.

```text
FIN-005
`scheduled_transactions.amount` is a snapshot taken at whatever exchange rate was
current when it was written, not a description of what the occurrence will post.
For an FX-sensitive schedule -- a top-level investment, whose `amount` is the
security-currency cash impact, or a split parent carrying an investment line --
it stops describing the occurrence the moment a referenced security's or
account's currency changes.

The current amount is resolved, once, by
`ScheduledEffectiveAmountService.resolveMany`: the stored rate when its recorded
pair is still the settlement pair (because that is what posting will reuse),
otherwise a freshly resolved rate, and `null` when a genuine cross-currency pair
has no determinable rate. Every surface that presents or aggregates an
occurrence's cash amount reads that answer, in the settlement currency it names,
and reports `null` as unavailable. A total containing an unknown component is
`null` with the partial sum in a separately named field.
```

The persisted scalar is never the fallback. Substituting it turns "we do not know
what this will cost" into a confident wrong number -- 1,500 CAD for an occurrence
that posts 1,350 -- and it did so on five product surfaces at once while the
cash-flow forecast beside them was right (issue #1247).

Nor is the recurrence slot the due date. An override is addressed to a slot
(`original_date`, the occurrence's identity) and may move the occurrence to
another day (`override_date`); a surface that filters, sorts or prints the slot
announces a payment on a day the user has already changed. Both halves come from
one place -- `expandOccurrenceSlots` decides which occurrence, and
`ScheduledOccurrenceService` prices it -- because centralizing the arithmetic
alone left every consumer free to pick the wrong occurrence and be confidently
wrong about a number that was itself correct. INV-OCCURRENCE-003 in
`docs/system-invariants.md` records the enforcement.

## 8. Import and restore: zero, null, absent

The MS Money importer is deliberately not uniform, and the distinction is worth
preserving rather than tidying:

- **Investment `price` and `quantity` propagate `null`.** `positiveOrNull`
  returns `null` for an absent or non-positive value, and the writer stores it
  as `null`. This is what keeps the zero-price-acquisition guard able to see
  "unknown" rather than "free".
- **Cash amounts default to `0`.** `toAmount` returns `0` for a missing or
  non-finite value, and `total_amount` is `NOT NULL` with no null path. This is
  defensible because Money's own missing-column semantics already collapse to
  zero for a cash figure -- an absent `amt` genuinely means zero, not unknown.

The rule that follows is about which of the two a new field is:
`docs/financial-calculation-contract.md`'s note that `null` means "not known"
and a settled zero must not be reported as unknown applies in both directions
here. Decide which the source column actually means before choosing a default.

## 9. Loan and mortgage interest

### The periodic rate is the nominal annual rate divided by the payments per year

Outside one legal exception, a loan or mortgage rate is quoted as a **nominal
annual rate compounded at the payment frequency**, so the rate charged per
period is `annualRate / periodsPerYear` -- `0.06 / 26` for a biweekly mortgage,
not `(1 + 0.06/12)^(12/26) - 1`.

The exception is Canadian **fixed-rate** mortgages, which must compound
semi-annually by law: `(1 + r/2)^(2/n) - 1`. Canadian variable-rate mortgages
and every non-Canadian mortgage use the nominal convention.

Both conventions are defensible and they disagree -- on 300k at 6% over 25
biweekly-paid years the difference is 0.68 on the installment and about 443 in
lifetime interest -- so the choice is a named contract, not a formula detail:

| Where | What implements it |
| --- | --- |
| Backend rate | `calculateStandardPeriodicRate` / `calculateCanadianPeriodicRate` in `backend/src/accounts/mortgage-amortization.util.ts` |
| Backend generic loan | `calculatePaymentSplit` / `calculateTotalPayments` in `backend/src/accounts/loan-amortization.util.ts` |
| Frontend projections | `getPeriodicRate` in `frontend/src/lib/loan-schedule.ts` |
| Displayed EAR | `calculateEffectiveAnnualRate`, compounding at the **payment** frequency |

The displayed effective annual rate has to describe the rate the schedule
actually charges. Compounding at 12 regardless of the payment frequency named a
rate nothing in the app used: a biweekly mortgage charges `r/26` twenty-six
times, so its EAR is `(1 + r/26)^26 - 1`. Canadian fixed keeps `(1 + r/2)^2 - 1`
whatever its payment frequency, because that is the rate the law defines.

Backend and frontend agreeing is **not** evidence for either convention -- they
deliberately mirror one formula, so parity can only detect drift, never a wrong
shared choice. The fixtures that hold this rule are derived independently of
both (`backend/src/accounts/mortgage-amortization.util.spec.ts`, "periodic-rate
convention"; `frontend/src/lib/loan-schedule.test.ts`).

### The first payment date is payment number 1

`accounts.payment_start_date` is the date of the **first** payment (the loan and
mortgage forms label it "First Payment Date"), so a schedule of N payments
advances only N - 1 intervals to reach its last one: 12 monthly payments from
2026-01-01 finish on 2026-12-01. `calculateEndDate` and
`calculateMortgageEndDate` own this, and the linked scheduled transaction's
`endDate` is derived from their answer -- so an off-by-one there dates every
displayed payoff, and the scheduler's own end, one full period late.

### The last payment is a residual, and the count that reaches it is derived

A whole payment count is a ceiling: the payment that clears the balance is the
remaining balance plus that period's interest, and it is normally smaller than
the installment. Lifetime interest therefore comes from
`calculateResidualPayoff`, never from `paymentAmount * totalPayments -
principal` -- that arithmetic bills a full installment for a partial period
(569 too much on a 25-year accelerated-biweekly mortgage) and disagrees with the
period-by-period schedule the same app shows afterwards.

A count *supplied* by a caller is a ceiling in the same way: an installment large
enough to clear the balance sooner makes it too high, and one that never covers
the interest makes it meaningless. So `calculateResidualPayoff` derives the
effective count itself with `paymentsToClear`
(`backend/src/accounts/amortization-count.util.ts` -- one implementation of
`n = -ln(1 - P*r/A) / ln(1+r)`, which had three) and returns it, so
`totalPayments`, `endDate` and the totals all come from one number. A
non-amortizing installment yields `-1` for all three, and the payoff date falls
back to the far-future sentinel, rather than a precise figure for a schedule with
no end.

The count's own spelling has to be real, too. `accounts.payment_frequency` holds
whichever enum wrote it -- the mortgage path's `SEMI_MONTHLY` or the loan-payment
setup dialog's `SEMIMONTHLY` -- and a value neither `getPeriodsPerYear` nor
`advanceDate` recognizes falls silently through to monthly: twice the interest per
period, and rows dated a month apart. Both spellings are handled on both layers,
and two scans hold it (`backend/src/accounts/loan-payment-frequency.guard.spec.ts`
reads the DTO's `@IsIn` list, `frontend/src/lib/loan-frequency.guard.test.ts` reads
the dialog's options), because each reaches its engine through a cast.

Two domains, so two tables and one conversion, all declared as data and all in
`backend/src/accounts/payment-frequency.util.ts`:
`LOAN_FREQUENCY_TO_RECURRENCE` and `MORTGAGE_FREQUENCY_TO_RECURRENCE` are
`Record`s over their unions (adding a frequency without deciding how it recurs is
a compile error), `SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY` is their merge for
the one service that receives both, and `toMortgagePaymentFrequency` converts a
recurrence spelling into the mortgage domain -- returning `null` for `QUARTERLY`
and `YEARLY`, which a mortgage in this model has no cadence for, so the caller
refuses rather than computing a confident wrong split. A cast in place of that
conversion split a semi-monthly Canadian mortgage at twice the correct interest
for the life of the loan.

**A module-level merge of two tables must not be able to run before both exist.**
Those tables started out in the two amortization utils, which then had to import
each other. Under a mortgage-first load order the spread ran while the mortgage
module was still initialising and `SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY` came
out holding only the loan keys -- so an accelerated-biweekly mortgage fell to the
caller's `?? "MONTHLY"` and its scheduled transaction was created monthly. A
completeness assertion cannot see that (by the time a test runs, everything is
loaded), so the guard requires the modules in the hostile order in a fresh
registry: `loan-payment-frequency.guard.spec.ts`, "payment-frequency module has
no import cycle". The neutral module is the fix; the guard is what keeps it.

The same list is what the account can store, so it is also what the form may
offer: `PAYMENT_FREQUENCIES` in `frontend/src/types/account.ts` is one runtime
list with the type derived from it, and `AccountForm`'s Zod enum is built from it.
That is not tidiness -- `optionalEnum` maps an unlisted value to `undefined`, so a
form list missing a frequency the backend stores would silently ERASE it the first
time anybody edited such an account.

### A payoff date is a date the scheduler reaches

`endDate` on a loan or mortgage exists to bound the linked scheduled transaction,
so it is stepped by `calculateNextDueDate` -- the recurrence engine that will post
those payments -- and not by a calendar of its own. `calculateEndDate` and
`calculateMortgageEndDate` convert through the frequency tables above and call
`advancePaymentDates`.

The same reasoning reaches the *projection*, and for every cadence rather than
semi-monthly alone: a borrower reads projected row dates and posted dates as one
calendar. `advanceDate` in `frontend/src/lib/loan-schedule.ts` therefore delegates
to `advanceByFrequency` through one `Record`
(`SCHEDULE_FREQUENCY_TO_RECURRENCE`), the browser-side twin of the two backend
tables. It used to spell the rule out instead, to keep the file out of the
scheduled-transaction domain of `frequency.guard.test.ts`, and only semi-monthly
was ever aligned: the month cadences stepped with `Date.setMonth(+1)`, which
overflows rather than clamps, so a loan paid on the 31st had its second projected
row dated 3 March -- February skipped -- while the backend's `calculateEndDate`
clamped to 28 February. Avoiding a guard's domain is not a reason to keep a
second calendar; the switch became a `Record` (as did `getPeriodsPerYear` and
`overpaymentsPerYear`), so the file is in that guard's scope and passes on its
merits. `loan-frequency.guard.test.ts` walks every cadence against
`advanceByFrequency`, month-end anchors included.

A hand-rolled semi-monthly step (the 1st and the 15th) against the engine's own
(the 15th and the last day of the month) dated payment 24 of a 24-payment
schedule *before* the final installment, so the schedule it bounded posted 23 of
them. It follows that month-end drift in a payoff date is whatever the
scheduler's drift is, by construction -- which is the only answer that keeps the
two consistent, and is now also what a *projection's* row dates do, since
`advanceDate` steps through the same engine.

A `Date` carrying a calendar date is UTC-midnight throughout these helpers, the
convention `ensureYMD` and `formatDateYMD` already share: every caller builds one
from a date-only string and every consumer reads it back in UTC. Reading LOCAL
components in between put every payoff date one day early outside UTC, by two
routes -- west of Greenwich the input read landed on the previous day, east of it
the local-midnight output did -- and CI's `TZ=UTC` cannot see either. Setting
`process.env.TZ` inside a Jest worker does not move `Date`, so
`backend/src/accounts/payment-frequency.timezone.spec.ts` walks the offsets in
child processes and scans the three helpers for a local accessor.

A negative count is unknown, not "at most one payment": `-1` is the sentinel
`calculateResidualPayoff` returns for a schedule it could not work out, and both
date helpers answer it with the far-future sentinel rather than the start date.
The dateable ceiling is one exported constant (`MAX_DATEABLE_PAYMENTS`) that the
helpers and `createLoanAccount`'s own guard compare against the same way, since
two literals disagreed at the boundary.

### A projection horizon is derived from the frequency, and a truncated total is unknown

`frontend/src/lib/loan-schedule.ts` projects at most
`DEFAULT_MAX_PROJECTION_YEARS` (50) years of payments, which is `periodsPerYear
* 50` rows -- 600 monthly, 1300 biweekly, 2600 weekly. A flat 600-payment cap
was not a horizon but a monthly-only one, and it cut ordinary 25- and 30-year
weekly and biweekly mortgages short. A 30-year weekly mortgage of 300k at 5%
runs 1560 payments and costs 279,367.53 in interest; stopped at 600 it reported
no payoff date, 232,723.84 still outstanding, and 155,557.54 of interest --
omitting 44% of the lifetime figure under a total's label.

When a schedule stops because it hit the horizon (`paidOff === false`), its
accumulated interest is the interest over that horizon, not the loan's lifetime
interest -- and its `numPayments` is a row count, its `payoffDate` is absent, and
its `finalPaymentAmount` is the installment at a mid-schedule row rather than at
its last payment. Per `docs/financial-calculation-contract.md` section 1 those
are subtotals: `LoanScheduleResult` carries them, and every consumer presenting a
lifetime figure, or a saving derived from one, gates on `paidOff` first.
`compareSchedules` returns `null` for all four of `interestSaved`,
`paymentsSaved`, `monthsSaved` and `installmentReduction`;
`PastImpactResult.interestAlreadySaved` and `monthsAlreadySaved` are `null`; the
goal-seek solver refuses a target it cannot prove was met; and both loan reports
withhold the projected payoff date and relabel the interest figure rather than
leaving "Est. Total Interest" over it.

Gating one of a set and leaving its siblings is the trap: `monthsSaved` came back
`0` from `monthsBetween(null, ...)`, which reads as "the overpayment bought no
time" rather than "not known", and sat next to an honest "Interest Saved:
Unknown" on the same card.

### A recurring overpayment cadence is a calendar, not a payment interval

A monthly overpayment happens twelve times a year on any loan. Deriving a fixed
payment interval instead (`Math.round(periodsPerYear / overpaymentsPerYear)`)
made "100 monthly" land every second biweekly payment -- thirteen times a year,
8.3% more cash than the borrower said they would pay, and interest savings
overstated to match.

So occurrences are dated: they fall on the cadence anchor (the overpayment's
start date, never before the first projected payment) and every cadence step
after it, and each one is applied at the first loan payment on or after its due
date. Each is derived from the anchor **by index**, not accumulated from the one
the one before it, on the recurrence engine -- the same calendar the loan's own
payment rows walk. Deriving each occurrence from the anchor by index kept a 31st
anchor on month-end (31 Jan, 28 Feb, 31 Mar, 30 Apr) while the rows accumulated
the engine's clamp (31 Jan, 28 Feb, 28 Mar, 28 Apr), so the occurrence due 31
March arrived after the 28 March row and the year paid eleven. (Earlier still,
`advanceDate` overflowed -- 31 January to 3 March -- losing February outright.)
The cost of the accumulating step is that a 31st anchor settles onto the 28th
after its first February rather than returning to month-end; on a loan whose own
payments have settled there it is no cost, and below the 29th the two are
identical. The count per calendar year is the invariant and survives both. `recurringOccurrencesDue` in `frontend/src/lib/loan-schedule.ts` is the
only place that decision is made, and it makes the cadence exact in both
directions: `MONTHLY`, `QUARTERLY` and `ANNUALLY` are calendar cadences, so they
contribute exactly 12, 4 and 1 occurrences per calendar year on a weekly,
biweekly or monthly loan; `WEEKLY` and `BIWEEKLY` are day cadences, so they
contribute one every 7 or 14 days -- 52 or 53 a year, exactly as a weekly
standing order does, rather than a levelled 52/12 per month that falls on no
payment date at all.

An occurrence is carried by the first loan payment on or after its due date, so
a cadence denser than the loan's payments arrives in batches (four or five
weekly occurrences on each monthly payment) and one due in late December is paid
by the January installment. That lag is the honest direction: interest is
charged for the days the money had not yet arrived.

`perPaymentExtraAmount` survives as a **display** average for the "resulting
monthly payment" card. It is not what the engine applies, and it must not be
used to compute a balance.

## 10. Gap register

Places where two paths currently answer the same question differently. Each was
confirmed by reading `main`; each is a divergence, not a style difference.

| Question | Divergence |
| --- | --- |
| What does a SPLIT do to a share count? | `holdings.service.ts` multiplies (`qty *= txQty`, and `next = current * quantity`). `net-worth.service.ts` **adds**, at all three of its reducers -- and at one of them SPLIT is grouped with `BUY`/`REINVEST`/`TRANSFER_IN`. The holdings page and every historical net-worth chart therefore disagree about the same position after any split. `net-worth.service.ts` also handles no `ADD_SHARES`/`REMOVE_SHARES` at all, so those move the share count in one view and not the other. Breaches FIN-003. |
| What is an unavailable rate worth? | `portfolio-calculation.service.ts` falls back to `rate = 1`; `net-worth.service.ts` returns `result ?? amount`, relabelling an unconverted amount as the target currency. Breaches FIN-002. |
| Is acquisition commission in the cost basis? | `calculateCostBasisLotsInAccountCurrency` includes it (`quantity * price + commission`); `calculateRealizedGains` does not (`quantity * price`), while still taking proceeds net of the sell commission -- so realized gain is overstated by the buy-side commission relative to every other basis figure in the app. The code comments this discrepancy itself and declines to resolve it, correctly noting that reconciling the two changes every realized-gain figure in the application and so is its own change. Recorded here so the two are not mistaken for one rule. |
| Does a status change reach both transfer legs? | `PATCH /:id/transfer` mirrors `status` to both legs. `PATCH /transactions/:id/status` (and `markCleared`/`reconcile`/`unreconcile`) touch only the row given -- the reconciliation service references neither `isTransfer` nor `linkedTransactionId`. Bulk update mirrors `payeeId`/`payeeName`/`description` to the linked leg but not `status`. Breaches FIN-001. |
| Does a cross-currency transfer need a real rate? | `exchangeRate` defaults to `1` with no server-side resolution or rejection, and balances are updated regardless of `status`, so a transfer created as `VOID` still moves both balances. Breaches FIN-001 and FIN-002. |
| Is a stored override price safe? | `OverrideEditorDialog` seeds from the stored value correctly, then an unconditional effect overwrites `investmentPrice` whenever the fetched market price differs from the last seen one, recomputing the total from it. Breaches FIN-004. |

A note on how these are meant to be closed. FIN-002 and FIN-003 are each
scattered across several call sites, and every previous attempt fixed one site
and left the others live. The durable form of these two rules is a scanning
test, per root `CLAUDE.md`: one that fails on any `: 1` else-branch beside a rate
lookup, any `?? amount` beside a conversion, and any `SPLIT` case outside the
single shared reducer. Prose has already been insufficient here more than once.
