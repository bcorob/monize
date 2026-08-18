# Spec: point-in-time account balances

Status: approved for implementation on `claude/account-balance-suggestions-u3an4n`.
Governs: issue #1198 -- the Account Balances report advertises "balance history
over a selected time period" and offers no date at all.

Read `docs/financial-calculation-contract.md` sections 1 and 8.1, and
`docs/specs/fx-conversion-completeness.md`, before changing anything here.

## 1. What the report is

A balance is measured at a single instant, so the report answers exactly one
question: **what was each account worth at the end of `asOfDate`?** The date is
free -- any day in the past or the future -- and defaults to the caller's today.

Everything else the issue asks for (which accounts are included, how they are
grouped, how they are sorted) is presentation over that one figure and is
decided on the client.

## 2. The behaviour this replaces

The report previously rendered `currentBalance + futureTransactionsSum`: today's
posted balance plus *every* future-dated transaction, however far out. That is
not a point in time -- it is a projection to the end of the ledger, and it was
labelled "balance". Two accounts with the same balance today but different
scheduled activity read as different balances with nothing on screen saying as
of when.

Under this spec the default view (`asOfDate` = today) shows today's balance, and
the end-of-ledger figure is reachable by picking that date. **This changes the
numbers the report displays for any user holding future-dated transactions**;
`AccountBalancesReport.test.tsx` carries the case that pins it.

## 3. Definitions

For an account `a` and a date `d` (YYYY-MM-DD):

**Ledger balance** -- the same expression `recalculateCurrentBalance` uses, with
`d` in place of today:

```
opening_balance + SUM(amount)
  over transactions WHERE account_id = a
    AND (status IS NULL OR status <> 'VOID')   -- a VOID row moved no money
    AND parent_transaction_id IS NULL          -- a split child is not a movement
    AND transaction_date <= d
```

**Market value** (holdings accounts only -- `INVESTMENT_BROKERAGE`, or
`INVESTMENT` with no sub-type): replay every non-VOID investment transaction
dated `<= d` through `applyActionToQuantity`, then value each non-zero position
at the security's close **standing for `d`**, converted into the account's
currency at the exchange rate standing for `d`.

"Standing for `d`" is `closeAt` (`backend/src/common/time-series/price-boundary.util.ts`),
the one door in `docs/time-series-contract.md` section 2.1: the most recent
observation at or before `d`, and only when it was struck within
`BOUNDARY_LAG_DAYS`. A rate is an observation on a date exactly as a close is,
so both go through it. Each query is bounded on both sides to exactly the window
the door accepts, so the read and the rule cannot disagree.

The bound is what stops a position last quoted months ago being reported at that
price under `d`'s heading -- an instrument that would then appear to have gone
nowhere since, from a single observation. A security outside the window is
**unpriced** for `d`, which makes the account's total null (section 4), not
smaller.

**Inception** -- the first date the account is a thing with a balance:
`date_acquired` when the account is an `ASSET` that carries one, and otherwise
the earliest non-VOID, non-child movement on either ledger (`transactions` and
`investment_transactions`). An acquisition date **wins** over an earlier
transaction rather than being minimised with it: the field's job is to say when
the asset started existing, and the two disagreeing is a correction the user has
already made, and a *future* acquisition date is honoured as written because it
is the user's own statement about an asset they do not own yet.

A first movement in the future is **capped at today**. The account's row is in
`accounts` as the query runs, so it demonstrably exists now whatever its ledger
says about next week; without the cap, an account funded with an opening balance
whose only entry is an upcoming bill disappears from today's own balance sheet.
The cap is not a waiver -- that account is still absent from any date before
today, because nothing says it was there.

An account with neither has no inception and is reported at every
date -- `created_at` is not a candidate, because it records when the row was
typed in, so an account imported today would vanish from its own history.

Before its inception an account is **absent**, not worth zero: `existsAsOf` is
`false` and `balance` is 0 rather than the opening balance the ledger sum would
otherwise carry back with it. The opening balance is the sum the account
*started* at, and an asset bought in 2024 was not worth its purchase price in
2019. The client drops those rows from the report entirely -- an empty row is a
measured zero, and this is not a measurement.

**The market date is `min(d, today)`.** The ledger runs ahead -- a transaction
can be dated next year -- and prices and rates cannot, so a future `d` reads the
market at today, the same clamp `ExchangeRateService.getRateForDate` applies and
for the same reason: today's figure is the best available estimate of a day that
has not happened.

Without the clamp the staleness bound refuses its own inputs. `closeAt` asks how
old an observation is *relative to the date being priced*, so a report dated a
year out would find today's close 365 days stale and call every position
unpriced -- and the bounded query would not return it in the first place.

So a future-dated report is the ledger projected forward, holding each position
at the most recent figure anybody knows. It is *not* a forecast: no price or
rate is extrapolated.

## 4. Missing data

Per the contract, a total is `null` unless every component is known.

| Condition | `marketValue` | `knownMarketValueSubtotal` | flags |
|---|---|---|---|
| every position priced and converted | the total | same number | `valuationComplete: true` |
| a held position has no accepted close for `d` -- none at all, or none newer than the boundary window | `null` | sum of the priced ones | `unpricedHoldingsCount > 0`, `pricesComplete: false` |
| a position's currency has no accepted rate to the account's currency | `null` | sum of the converted ones | `missingRatePairs` names the pair, `fxComplete: false` |
| account holds no positions at `d` | `0` | `0` | complete -- an empty portfolio is worth zero, not unknown |
| account is not a holdings account | `null` | `0` | `valuationComplete: true`; the field does not apply |

`balance` is never `null`: a ledger sum over rows the database holds is always
known, and an account with no transactions before `d` sits at its opening
balance -- unless `d` predates its inception, where it is 0 (section 3).

An account before its inception holds no positions either, because the replay is
bounded by `d` and the inception read covers the same investment rows -- so a
holdings account reports `marketValue: 0`, complete, exactly as an emptied one
does.

`valuationComplete` means *every component of every figure this row reports is
known*. A consumer reads it as `=== false`, never `!`, so a response from a
backend that predates the field reads as "no information" rather than
"incomplete". `existsAsOf` is read the same way and for the same reason: absent
means "no information", which is not "did not exist" -- hiding every account
during a rolling deploy is the worse reading of a missing field.

An investment pair is one entity with two ledgers, and they can come into
existence on different days (a cash sleeve funded before the first trade
settles). The client therefore drops an entity only when **every** member
account is `existsAsOf: false`.

## 5. Shape

```typescript
interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  /** Ledger balance in the account's own currency at the end of asOfDate. */
  balance: number;
  /** Holdings valued at asOfDate, account currency. null unless complete. */
  marketValue: number | null;
  /** The part of marketValue that is known. 0 for a non-holdings account. */
  knownMarketValueSubtotal: number;
  /** Held positions with no price at or before asOfDate. */
  unpricedHoldingsCount: number;
  /** "USD->CAD" for each pair with no rate at or before asOfDate. */
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  valuationComplete: boolean;
  /** False when asOfDate predates the account's inception (section 3). */
  existsAsOf: boolean;
}

interface AccountBalancesAsOfResponse {
  /** Echoes the date actually used, so a payload carries its own request key. */
  asOfDate: string;
  accounts: AccountBalanceAsOf[];
}
```

The response echoes `asOfDate` because the client offers actions beside it: a
payload without the date that produced it cannot be told from the previous one
(`frontend/CLAUDE.md`, "Asynchronous data carries the request that produced it").

## 6. Numerical examples

| Setup | `asOfDate` | `balance` | `marketValue` |
|---|---|---|---|
| opening 100, +50 on 2026-01-10, +25 on 2026-06-01 | 2026-03-01 | 150 | n/a |
| same | 2026-06-30 | 175 | n/a |
| same, the 2026-06-01 row VOID | 2026-06-30 | 150 | n/a |
| BUY 10 @ 20 on 2026-01-05, close 22 on 2026-02-27, none later | 2026-03-01 | 0 | 220 |
| same, plus SPLIT ratio 2 on 2026-02-01 | 2026-03-01 | 0 | 440 |
| same, but no close on or before the date | 2026-01-04 | 0 | `null` |
| same, last close 2025-09-30 (outside the window) | 2026-03-01 | 0 | `null` |
| BUY 10 @ 20 USD in a CAD account, no USD->CAD rate | any | 0 | `null` |
| opening 100, first transaction 2026-01-10 | 2026-01-09 | 0 (absent) | n/a |
| same | 2026-01-10 | 150 | n/a |
| opening 100, no transactions, no acquisition date | 1999-01-01 | 100 | n/a |
| opening 500, only movement dated next month | today | 500 | n/a |
| same | yesterday | 0 (absent) | n/a |
| ASSET, `date_acquired` 2024-06-15, opening 450000 | 2024-06-14 | 0 (absent) | n/a |
| same | 2024-06-15 | 450000 | n/a |

## 7. Display currency

Every figure is presented in the user's reporting currency **at the rate that
stood on `d`** -- the summary cards, the group subtotals, the chart and the
per-row approximation alike. A point-in-time report converts at that point in
time: asked what an account held in 2019, "what it was worth then" is the
question, and today's rate answers a different one.

The rates therefore travel in the payload beside the figures they belong to:

```typescript
displayCurrency: string;              // the user's reporting currency
displayRates: Record<string, number>; // account currency -> multiplier, on d
```

A currency the server could not resolve a rate for on `d` is **omitted** from
the map, never given 1. `asOfConverter`
(`frontend/src/components/reports/account-balances/as-of-rates.ts`) is the one
place that map is read; it returns `null` for an omitted currency, and for a
rate that is present but not a usable positive number, so those accounts leave
the totals through `sumConverted` and are marked by `PartialTotal` rather than
being folded in unconverted. `displayCurrency` itself is present at 1, because
same-currency is 1:1 by definition and has to stay distinguishable from missing.

Shipping the rates with the figures is also what keeps the two from drifting:
while a new date is in flight the client still holds the previous response, and
converting it with a live rate map would present one date's balances at another
date's rates with nothing on screen saying so. `useExchangeRates` stays the
right tool for a surface reporting *now*; it is the wrong one here.

An account row still prints its own balance in its own currency -- that figure
is not a conversion -- and so do the CSV and PDF table rows. Only what is summed
across accounts is converted.

## 8. Test matrix

The backend spec must cover, at minimum:

1. Ledger balance at a past date excludes later rows, at a future date includes
   them, and at today equals `current_balance` for an account with no future
   rows.
2. A VOID row contributes nothing at any date.
3. A split child contributes nothing (its parent already carries the total).
4. An account with no transactions before the date reports its opening balance.
5. Holdings replay honours SPLIT as a ratio, and ADD_SHARES / REMOVE_SHARES.
6. A position with no price at or before the date -> `marketValue: null`,
   `unpricedHoldingsCount` counts it, `knownMarketValueSubtotal` holds the rest.
7. A position whose currency has no rate -> `marketValue: null` and the pair is
   named.
7a. A close, and separately a rate, older than `BOUNDARY_LAG_DAYS` is refused
   the same way; one a few days old carries forward across a weekend.
8. A holdings account with no positions -> `marketValue: 0`, complete.
9. A rejected date (not YYYY-MM-DD) is a 400 and writes nothing.
10. `displayRates` carries the reporting currency at 1, resolves a foreign
   currency at the date's rate (including a pair stored only in reverse), and
   omits a currency it has no accepted rate for.
11. A future date sums the ledger to that date while reading prices and rates at
   today, and its positions are valued rather than reported unpriced.
12. Inception (section 3): an asset is `existsAsOf: false` with `balance: 0`
   before `date_acquired` and reported from that day onwards; the acquisition
   date wins over an earlier transaction; `date_acquired` on a non-`ASSET`
   account is ignored; an account with a later first transaction withholds its
   opening balance until that day; an account with neither is reported at every
   date; a brokerage is dated from its investment transactions; a first movement
   still ahead of today is capped at today (reported today, absent yesterday)
   while a future acquisition date is not; and the inception read is unbounded
   by `d` and restricted for a delegate.

The client tests must cover the filters, the grouping keys, the sort orders, the
default-date change in section 2, conversion at the payload's rates, and an
omitted currency leaving the totals marked partial -- plus, for section 3: an
`existsAsOf: false` account leaving both the rows and the totals, its group
heading going with it, a pair surviving on one live member, a row with the field
absent still rendering, and the empty state naming the date rather than the
filters.
