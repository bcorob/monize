# Microsoft Money Data Model

Reference for the `.mny` file format. A `.mny` file is a Jet 4 database in a
Money-specific variant ("MSISAM"), so the tables below are ordinary Access
tables once the file is decrypted.

None of this is official documentation. It is reverse-engineered, and the parts
that were never observed say so.

> **Provenance.** The original of this document is
> `poc/import-from-dotmny:migration/ms-money-data-model.md` -- a path in that
> branch's tree, not in this one -- from PR #192 by
> **marksimpson**, derived from analysis of a real 30-year Money file. That
> analysis is the foundation of Monize's `.mny` importer and the single most
> valuable thing the proof of concept produced.
>
> This version carries corrections found while building the native importer.
> Where the two disagree, the disagreement is called out inline with a
> **Correction** note and the evidence for it, because the original is still in
> circulation and someone reading both should be able to see which claim won and
> why. Design rationale lives in `docs/future-plans/mny-import.md`; the code that
> implements all of this is `backend/src/import/mny/`, whose `README.md` lists
> the traps in the order you will hit them.

## Dates

`mdb-reader` decodes Jet datetimes natively, from an absolute epoch. Dates
arrive as JavaScript `Date` objects and need no parsing.

> **Correction.** The original describes dates as `MM/DD/YY HH:MM:SS` strings
> with a null sentinel of day `00` and a 70-year pivot for the two-digit year.
> That is what `mdb-export` prints, not what the file holds -- the pivot logic
> is an artefact of the CSV round-trip, and reproducing it would misdate every
> pre-1970 transaction.
>
> The real "no date" sentinel is **year 10000** (`+010000-02-28`). It is common:
> 1,320 of the 2,292 date values in `money2002.mny` are it. Jet's own zero date
> (1899-12-30) also appears. Monize normalises anything outside 1900–2199 to
> null (`model/mny-values.ts`, `toDate`).

## Key tables

| Table | Purpose |
|-------|---------|
| `DHD` | File defaults -- one row, holds the base currency |
| `ACCT` | Accounts (bank, investment, loan, etc.) |
| `PAY` | Payees |
| `CAT` | Categories (hierarchical) |
| `CRNC` | Currencies |
| `CRNC_EXCHG` | Exchange rate history |
| `SEC` | Securities (stocks, funds, and currency pseudo-securities) |
| `SEC_SPLIT` | Stock splits |
| `SP` | Security price history |
| `TRN` | All transactions, cash and investment alike |
| `TRN_INV` | Investment detail for a `TRN` row (quantity, price, commission) |
| `TRN_SPLIT` | Split transaction children |
| `TRN_XFER` | Transfer pairs |
| `LOT` | Tax lots -- Money's authoritative record of share ownership |
| `BILL` | Scheduled transaction instances |

Not every table exists in every Money version. `BILL` is absent from Money 2001
entirely, which is what crash-looped the proof of concept. Monize reads every
table through `getTableOrNull` and every column through a spec with a declared
default, so an absent table yields zero rows and an absent column yields the
default -- both reported rather than thrown (`tables/table-reader.ts`).

## Table relationships

```
TRN (htrn) ──1:0..1──> TRN_INV (htrn)
TRN (htrn) ──1:0..*──> TRN_SPLIT (htrn)         child TRN row
TRN (htrn) ──1:0..*──> TRN_XFER (htrnFrom)      from side
TRN (htrn) ──1:0..*──> TRN_XFER (htrnLink)      to side
TRN (hacct) ──────────> ACCT (hacct)
TRN (hsec)  ──────────> SEC (hsec)
TRN (lHpay | hpay) ───> PAY (hpay)              column renamed in Money Plus
TRN (hcat)  ──────────> CAT (hcat)
TRN (hbillHead) ──────> BILL (hbillHead)        series this instance belongs to
LOT (htrnBuy)  ───────> TRN (htrn)
LOT (htrnSell) ───────> TRN (htrn)
LOT (hacct) ──────────> ACCT (hacct)
LOT (hsec)  ──────────> SEC (hsec)
CAT (hcatParent) ─────> CAT (hcat)              self-referencing
BILL (lHtrn) ─────────> TRN (htrn)              template transaction
SP (hsec)  ───────────> SEC (hsec)
SP (hss)   ───────────> SEC_SPLIT (hss)         the only route to a split's security
CRNC_EXCHG (hcrncFrom) > CRNC (hcrnc)
CRNC_EXCHG (hcrncTo)  ─> CRNC (hcrnc)
DHD (hcrncDef) ───────> CRNC (hcrnc)            the file's base currency
ACCT (hacctRel) ──────> ACCT (hacct)            investment/cash pairs
```

Not every investment-related `TRN` row has a `TRN_INV` row. Cash dividends and
interest (`act` 3 and 4) and cash corporate actions (`act` 14) exist only in
`TRN`. **Drive an investment importer from `TRN`, never from `TRN_INV`** --
iterating `TRN_INV` drops every dividend, which is exactly what the proof of
concept did.

### `TRN.hpay` is `TRN.lHpay` in Money Plus

A file has exactly one of the two columns. Reading only `hpay` drops every payee
on a Money 2001 or 2002 file; reading only `lHpay` drops them on a Money Plus
file. Monize's reader takes a list of column aliases, newest first.

## DHD (file defaults)

| Field | Description |
|-------|-------------|
| `hcrncDef` | FK to `CRNC` -- **the file's base currency** |
| `hcrncCur` | Display currency. Null in every file examined |
| `lcid` | Windows locale id |

> **Addition.** The original has no `DHD` section. The base currency has to come
> from here: hardcoding a fallback is what left the proof of concept importing a
> British file as NZD.

## PAY (payees)

| Field | Description |
|-------|-------------|
| `hpay` | Primary key |
| `szFull` | Payee name |
| `fHidden` | Hidden flag |

Money keeps degenerate rows -- `#`, `*`, names that are empty once trimmed --
which are internal placeholders and never real payees.

## CAT (categories)

| Field | Description |
|-------|-------------|
| `hcat` | Primary key |
| `szFull` | Category name |
| `hcatParent` | FK to parent category (null for the two roots) |
| `nLevel` | Depth (0 = root) |
| `lType` | Income/expense classification -- see below |
| `fTax` | Tax-related flag |

Sort by `nLevel` ascending when inserting, so parents exist before children.

Every tree descends from one of two roots: `INCOME` (`hcat` 130) and `EXPENSE`
(`hcat` 131), the only rows with `nLevel` 0 and a null `hcatParent`.

> **Addition.** `lType` is missing from the original, and it is the clean signal
> for income versus expense: `{2, 3}` income, `{0, 1}` expense, `-1` for the two
> roots themselves. Cross-tabbed against root ancestry over 349 categories in
> three Money vintages, there is no crossover. Root-ancestor classification is
> the fallback for the roots, not the primary signal.

## CRNC (currencies)

| Field | Description |
|-------|-------------|
| `hcrnc` | Primary key |
| `szIsoCode` | ISO 4217 code (`GBP`, `USD`, ...) |
| `szName` | Currency name |
| `szSymbol` | Quote symbol, always shaped `/GBPUS` |
| `fHidden` | Hidden flag. **Absent before Money Plus** |

## CRNC_EXCHG (exchange rates)

| Field | Description |
|-------|-------------|
| `hcrncFrom` | FK to `CRNC` -- source currency |
| `hcrncTo` | FK to `CRNC` -- target currency |
| `dt` | Rate date |
| `rate` | Exchange rate |
| `fHist` | Historical flag |

## ACCT (accounts)

| Field | Description |
|-------|-------------|
| `hacct` | Primary key |
| `szFull` | Account name |
| `at` | Account type (below) |
| `hcrnc` | FK to `CRNC` |
| `amtOpen` | Opening balance |
| `amtLimit` | Credit limit |
| `dtOpen` / `dtClose` | Opened / closed dates |
| `fClosed` | Closed flag |
| `fFavorite` | Favourite flag |
| `hacctRel` | Linked account, meaningful for `at = 5` |
| `mComment` | Free-text comment |

### Account types (`at`)

| at | Meaning | Monize type |
|----|---------|-------------|
| 0 | Bank (chequing/savings) | CHEQUING |
| 1 | Credit card | CREDIT_CARD |
| 2 | Cash | CASH |
| 3 | Asset | ASSET |
| 4 | Loan | LOAN |
| 5 | Investment | INVESTMENT (paired) |
| 6 | Mortgage | MORTGAGE |

Only `at` 0 and 5 appear in the committed fixtures; the rest are carried from
the original and are marked unconfirmed in `model/mny-model.ts`. An `at` value
outside this table is skipped with a counted warning, never guessed at.

### Investment account pairs

An investment account (`at = 5`) points at its cash sleeve through `hacctRel`.
This maps exactly onto Monize's linked INVESTMENT_CASH + INVESTMENT_BROKERAGE
pair. Not every investment account has one.

> **Correction.** A `z ` prefix on an account name is *not* a Money closure
> signal -- it is one user's personal naming convention, and treating it as one
> closes accounts that are open. Only `fClosed` marks an account closed.

## TRN (all transactions)

| Field | Description |
|-------|-------------|
| `htrn` | Primary key |
| `hacct` | Account FK |
| `hacctLink` | Linked account, for some transfers |
| `hsec` | Security FK -- **its presence is what makes a row an investment row** |
| `dt` | Transaction date |
| `amt` | Cash amount, signed (negative = cash leaving the account) |
| `act` | Action type (below) |
| `hcat` | Category FK |
| `lHpay` / `hpay` | Payee FK |
| `mMemo` | Memo |
| `szId` | Reference, behind a one-digit kind marker (below) |
| `cs` | Cleared status: 0 unreconciled, 1 cleared, 2 reconciled |
| `frq` | `-1` for a real posting; anything else is a scheduler artefact |
| `grftt` | Bit flags (below) |
| `hbillHead` | Bill series this row was posted for. **Absent in Money 2001** |

An investment row is identified by carrying a security, not by its action code:
`act = 0` is BUY and is indistinguishable from a plain payment by `act` alone.

> **Correction.** The original gives `szId` as the reference number outright. It
> is the reference behind a leading digit naming its kind, and importing the
> string whole puts `1Debit` and `0           2` in the register.
>
> - `1` prefixes free text -- Debit, ATM, Telebank, PC Banking, EComm. 2,209
>   rows in the maintainer's file, not one of them numeric.
> - `0` prefixes a number right-aligned in twelve characters, so the value is
>   always thirteen characters long. 1,060 rows, every one numeric.
>
> A `0` number in a loan or mortgage account is Money's instalment counter, not
> a reference: 657 of the 1,060 sit in debt accounts counting up the payment
> schedule, all 461 in Money Plus's own `sample.mny` are the Home Loan payment
> numbers, the bank side of the transfer carries none of them in any of 642
> cases, and Money's loan register has no Num column to show one in.
>
> Both shapes are matched strictly and anything else is passed through, so a
> cheque number typed as `1042` stays `1042` rather than becoming the text `042`
> behind a kind digit (`model/mny-model.ts`, `decodeReference`).

### The `act` field

The original's table is reproduced in the **Correction** below; this one is what
the files measure, read off `LOT` (which transaction opened and closed each tax
lot) and `TRN_XFER` (whether Money records a cash counterpart at all).

| act | Meaning | `TRN_INV` row? | Cash counterpart? | Monize action |
|-----|---------|:--------------:|:-----------------:|---------------|
| 0 | Buy, Money 2001-era | yes | — | BUY |
| 1 | Buy | yes | 2,015 of 2,029 | BUY |
| 2 | Sell | yes | 165 of 180 | SELL |
| 3 | Cash dividend | **no** | 1,090 of 1,090 | DIVIDEND, amount from `TRN.amt` |
| 4 | Interest paid to cash | **no** | — | INTEREST, amount from `TRN.amt` |
| 5 | Reinvest (variant) | yes | — | REINVEST + warning |
| 9 | Reinvested distribution | yes | **0 of 1,020** | REINVEST |
| 10 | Reinvest Interest | ? | — | REINVEST_INTEREST + warning |
| 12 | Add Shares: units credited to a plan account | yes | **0 of 92** | REINVEST + warning |
| 13 | Remove shares / close lots | yes | — | REMOVE_SHARES |
| 14 | Cash corporate action | **no** | — | CAPITAL_GAIN + warning |
| 15 | Add shares / open lots | yes | — | ADD_SHARES, or TRANSFER_IN when paired |
| 16 | Remove shares / close lots | yes | — | REMOVE_SHARES, or TRANSFER_OUT when paired |
| 24 | S-Term Cap Gains Dist, paid to cash | ? | — | CAPITAL_GAIN_SHORT + warning |
| 26 | L-Term Cap Gains Dist, paid to cash | ? | — | CAPITAL_GAIN_LONG + warning |
| 27 | Reinvest S-Term CG Dist | ? | — | REINVEST_CAPITAL_GAIN_SHORT + warning |
| 29 | Reinvest L-Term CG Dist | ? | — | REINVEST_CAPITAL_GAIN_LONG + warning |
| 30 | Redeem CD/Bond | ? | — | REDEEM + warning, amount from `TRN.amt` |
| 32 / 33 | Share transfer in / out | yes | — | TRANSFER_IN / TRANSFER_OUT |
| -1 | Regular non-investment transaction | no | — | — |

`act` 5 and 14 have never been observed in any available file; 12 has been
observed, and issue #1149 supplies Money's own name for it ("Add Shares") --
Monize keeps mapping it to REINVEST so the stated value survives as cost basis.
The `act` 10 / 24 / 26 / 27 / 29 / 30 family was named by issue #1149's reporter
against Money's own register (the labels match Money's QIF vocabulary --
`ReinvInt`, `CGShort`, `CGLong`, `ReinvSh`, `ReinvLg`), but no file measured
here carries one, so their `TRN_INV` shape is marked `?` above. All of these are
listed in `MNY_UNCONFIRMED_ACTIONS`, so every transaction mapped through them
carries a warning rather than a silent mapping. `act` 4 is the code that
graduated: its cash-only shape was measured on both Money Plus files, issue
#1149 named it (Money's "Interest" activity, `IntInc` in QIF), and it now maps
to INTEREST -- it imported as DIVIDEND while the name was unknown, which
misfiled it for tax purposes. `act` 17, 18 and 20 occur in real files but open
and close no lot and have no name, so nothing says what they do to a position:
they stay unmapped and their rows are skipped and counted.

Money's register displays these cash distributions positive while `TRN.amt`
stores them with the file-side sign convention (the one that stores a BUY
positive), so the raw amounts on flagged preview rows can read negative. The
mapper discards the sign and takes direction from the action.

> **Correction.** The original gives `0` Buy, `1` Sell, `3` Reinvest and `5`
> Reinvest (variant). `LOT` disagrees at the first two: `act` 1 opens 3,520 lots
> in a real Money Plus file and closes none, and `act` 2 is the sale. Read that
> way, every purchase imported as a sale, no cash ever left a brokerage sleeve,
> and holdings replayed negative. `act` 3 has no `TRN_INV` row, which is a
> dividend rather than a reinvestment; `act` 9 is the reinvestment.

#### `act` 12 credits units that no cash pays for

It opens lots and carries a value and a quantity, so it looks exactly like a
buy -- and mapping it as one overdrew a cash sleeve by $18,457.22 against
Money's own $91.00. What separates it is the cash counterpart: `act` 1 pairs
with a cash row through `TRN_XFER` 2,015 times in 2,029 and `act` 3 does 1,090
times in 1,090, while `act` 12 does so **zero** times in 92 -- exactly like the
`act` 9 reinvestments. 82 of those 92 rows sit in one RRSP whose `ACCT` row has
`fEmpMatch` set, which is what the units appear to be: an employer's side of a
plan contribution, credited without passing through the member's cash.

REINVEST is the Monize action that matches: a value and a position, no cash leg,
cost basis preserved.

Issue #1149 supplied Money's own name for the code: it is the "Add Shares"
activity, which Money also uses for zero-quantity account true-ups and
sub-account transfers that leave the parent account unchanged (those rows
carry a price and a memo but move nothing, and import as valueless REINVEST
rows). The REINVEST mapping is kept deliberately -- Monize's ADD_SHARES
records shares with no cost, so mapping to it would discard the stated value
that Money's Add Shares preserves as basis.

#### `act` 16 closes lots; it is not a sale

The name suggests shares arriving. The `LOT` table proves the opposite: `act` 16
appears as `htrnSell`. A share transfer between accounts is recorded as `act` 16
on the source (closing lots) and `act` 15 on the destination (opening them with
cost basis). Mapping 16 to SELL closes lots against a fabricated price and
corrupts average cost, which is one of the four causes of the "investment
accounts are a mess" report on PR #192.

The two sides carry no link column. They pair implicitly on date, security and
quantity; an unpaired row stays ADD_SHARES or REMOVE_SHARES, which is correct
and common -- shares transferred in from a broker is simply how a portfolio
starts, and `money2002.mny` alone has 60 such rows.

#### Quantity is always positive

`TRN_INV.qty` is stored positive whatever the action. Direction comes only from
`act`. `TRN.amt` is signed but is no better a signal: a dividend reinvestment
(`act` 3 or 5) also has a negative `amt`, being cash spent on shares, and would
read as a sale.

> **Refinement.** Magnitude comes from `TRN.amt`, not from `qty * price +
> commission`. Money's own cash figure already includes commission and accrued
> interest, so recomputing it disagrees with what Money displays by exactly
> those amounts. Take the magnitude from `amt` and the sign from the action.

### The `grftt` bit field

Measured against a real Money Plus file (53,079 `TRN` rows over 56 accounts) by
cross-tabbing each bit against facts the file already settles: which account a
row sits in, whether it appears in `TRN_SPLIT` or `TRN_XFER`, whether it carries
`hsec`, what its memo says.

| Mask | Meaning | What fixes it |
|------|---------|---------------|
| `0x2`, `0x4` | Transfer side | 100% of rows carrying either appear in `TRN_XFER` |
| `0x10` | Investment row | 100% carry `hsec` |
| `0x20` | Split parent | 100% appear as `TRN_SPLIT.htrnParent` |
| `0x40` | Split child | 100% appear as `TRN_SPLIT.htrn` |
| `0x80` | Row is in a loan or mortgage account | 1,239 rows, every one of them in a debt account, and every row in those accounts has it |
| `0x100` | Voided | 31 rows, all `cs = 2`, half zero-amount, memos naming a cancelled or never-presented cheque |
| `0x4000` | Loan-payment template | 50 rows, exactly the ten account-less `ps = 5` split parents plus their legs and those legs' `TRN_XFER` counterparts -- set equality both ways, one family per debt account |
| `0x20000`, `0x40000` | A scheduled instance Money never posted | 67 rows, none reconciled where the file is 74% reconciled, all inside one eleven-month window, all also carrying `0x200000`; excluding them lands four accounts on Money's own balances, and the register does not show them |
| `0x200000` | Member of a scheduled series | 4,653 of 4,692 are `frq != -1` templates, and no template lacks it |

`0x8000` and `0x80000` do not occur in the file at all.

### Loan-payment templates

Money stores the *next* scheduled payment for each loan or mortgage as a
transaction family the register never shows: a split parent with **no `hacct`
at all**, its principal and interest legs, and each transfer leg's counterpart
sitting in the loan account with a real account and a real date. Its amount
mirrors the loan's current payment, so it reads exactly like a genuine posting.

`BILL.lHtrn` does **not** reference these, so the bill-template filter misses
them. Only the parent is self-evidently unusable (no account); the counterparts
are not, and importing them adds principal that no payment funded -- $9,902.63
across seven of the maintainer's debt accounts. `grftt & 0x4000` is what
identifies the whole family, and it is the only reliable handle on it.

> **Correction.** The original reference had `0x80` as "voided" and `0x8000` as
> "auto-entered". Both are wrong, and the first one is expensive: `0x80` is the
> bit *every loan and mortgage payment* carries, so every loan payment imported
> with status VOID. Monize's balance logic then excluded them, and each loan and
> mortgage sat frozen at its opening balance with a full register above it.
> 1,084 of the file's 33,734 transactions imported voided; the real number is 31.
>
> The general lesson: an unconfirmed constant that maps *silently* -- as opposed
> to `mapAccountType` and friends, which return null and warn -- has to be
> checked against a real file before it is trusted. A wrong bit mask produces no
> warning, no skipped row and no error; it just quietly means something else.

### Phantom transactions

`TRN` holds rows that are not postings and must not be imported:

1. **Scheduler artefacts** (`frq != -1`).
2. **Bill template transactions**, referenced by `BILL.lHtrn`. Templates, not
   postings.
3. **Split children**, referenced by `TRN_SPLIT.htrn`. Their amounts belong to
   the parent; importing them standalone double-counts.
4. **Dangling transfer sides** -- a `TRN_XFER` reference to a `htrn` that is not
   in the file at all.

> **Correction, and the most costly one.** The original also excludes
> scheduler-posted rows (which it read as `grftt & 0x8000`) and voided rows
> (which it read as `grftt & 0x80`). Both are wrong.
>
> *Scheduler-posted rows are real postings.* Money's scheduler posts loan
> payments, so excluding them deletes the loan side of every mortgage payment --
> which is why loans imported with zero transactions in the proof of concept.
> The phantom rule is `frq != -1` and nothing else.
>
> *Voided rows are real rows.* They should be imported with a VOID status, which
> Monize's balance logic already excludes from totals. Dropping them loses the
> record that the transaction existed at all. The void bit is `0x100`; `0x80`
> marks a debt-account row and voids nothing (see the `grftt` table above).
>
> **A counterpart in an account the user chose not to import is not orphaned
> either.** It keeps its row as a plain transaction with a warning: dropping it
> would silently remove real money from an account that *was* imported.

## TRN_INV (investment detail)

| Field | Description |
|-------|-------------|
| `htrn` | FK to `TRN`, and the primary key |
| `dPrice` | Price per unit |
| `qty` | Quantity, always positive |
| `amtCmn` | Commission |
| `amtInt` | Accrued interest |

## TRN_SPLIT (split children)

| Field | Description |
|-------|-------------|
| `htrn` | FK to `TRN` -- the child row |
| `htrnParent` | FK to `TRN` -- the parent |
| `iSplit` | Position within the split |

Amount, category and memo live on the child's own `TRN` row, not here.

**A split child that also appears in `TRN_XFER` is a transfer leg, not a
category leg.** This is how Money records a loan payment: the principal is a
transfer into the loan account, the interest is an ordinary category leg.
Importing the child as category-only loses the transfer, which is the second
half of the loans-import bug. In Monize it becomes a
`transaction_splits.kind = 'transfer'` row wired to the counterpart, and the
counterpart is imported exactly once.

## TRN_XFER (transfer pairs)

| Field | Description |
|-------|-------------|
| `htrnFrom` | FK to `TRN` -- the from side |
| `htrnLink` | FK to `TRN` -- the to side |

Both sides exist as separate `TRN` rows with their own amounts. Because the
pairing is exact, a `.mny` importer must never fall back to matching transfers
by name and amount the way a QIF importer has to.

## LOT (tax lots)

Money's authoritative record of share ownership.

| Field | Description |
|-------|-------------|
| `hlot` | Primary key |
| `hacct` | Account FK |
| `hsec` | Security FK |
| `qty` | Remaining open quantity |
| `htrnBuy` | FK to `TRN` -- the transaction that opened the lot |
| `htrnSell` | FK to `TRN` -- the transaction that closed it, empty while open |
| `dtBuy` / `dtSell` | Buy and sell dates |

Open positions are the sum of `qty` over lots with an empty `htrnSell`. This is
the most reliable statement of what Money considers held: it sidesteps replaying
transactions and handles transfers, splits and corporate actions for free.

Monize does **not** import holdings from `LOT`. Holdings come only from the
canonical rebuild over imported transactions -- a second, private fold is what
left the proof of concept with negative positions. `LOT` is used instead as an
independent check: open lots against the action replay, and both against what
Monize ended up holding, with any disagreement reported as a verification
warning rather than a failed import.

## SEC (securities)

| Field | Description |
|-------|-------------|
| `hsec` | Primary key |
| `szSymbol` | Ticker symbol, often empty |
| `szFull` | Full name |
| `sct` | Security type |
| `hcrnc` | Currency FK |
| `fHidden` | Hidden flag |

Symbols follow a few conventions: plain for domestic equities, exchange-prefixed
for foreign ones (`GB:VOD`, `US:VT`), and empty for many funds.

> **Correction.** The original gives `sct` a fixed meaning (`1` stock, `2` bond,
> `3` mutual fund, `4` currency). **The codes shift between releases.** The same
> Amex index securities are `sct` 6 in Money 2001 and 2002 and `sct` 7 in Money
> Plus, and `sct` 3 is a unit trust in one of them. Any fixed mapping mislabels
> some file, so Monize deliberately leaves `securityType` null for the user to
> set.
>
> **`sct = 4` is a money-market fund, not a currency.** Money Plus's own
> `sample.mny` files Vanguard, Merrill Lynch, Smith Barney and Woodgrove money
> market funds under it; a real Money Plus file's four `sct = 4` rows are TD
> Canadian Money Market, CIBC Canadian Money Market, CIBC Canadian T-Bill and
> McLean Budden Money Market. Excluding the code as a currency dropped 829 of
> that file's 4,524 investment transactions and left five brokerage cash sleeves
> thousands of dollars out, because the money-market fund *is* the sweep account
> the cash moves through.
>
> Currencies are not in `SEC` at all in any file measured -- they live in `CRNC`,
> whose `szSymbol` always has the shape `/GBPUS`. That symbol shape is the entire
> test Monize applies to a `SEC` row (`isCurrencyPseudoSecurity`); no `sct` code
> is read for meaning anywhere.

## SEC_SPLIT (stock splits)

| Field | Description |
|-------|-------------|
| `hss` | Primary key |
| `cshrPre` | Shares before the split |
| `cshrPost` | Shares after the split |
| `dtRecord` | Record date |
| `dPriceSplit` | Price at the split |

> **Addition, with a trap.** The original omits this table.
>
> **`SEC_SPLIT` carries no security handle.** The link runs the other way:
> `SP.hss` points at `SEC_SPLIT.hss`, and the `SP` row's `hsec` is the security.
> Looking for an `hsec` column here finds nothing, because there is not one.
>
> **Money does not apply these rows to share counts, and neither should you.**
> The obvious reading -- ignoring a split leaves every later position wrong by
> its ratio -- is wrong for this table, and two files say so at seven positions
> with no counter-example. A brokerage holding 200 shares bought before a 1:2
> `SEC_SPLIT` and 100 after transfers away in a single 300-share row, and `LOT`
> shows both purchases fully consumed; applying the ratio leaves 200 shares in an
> account Money shows as empty. `sample.mny` agrees: `LOT` holds 3 MSFT against 6
> replayed with its 1:2 split, and 110.25 ADM against 115.7625.
>
> What the rows are is visible in the price history: the `SP` row a split points
> at carries `dPrice = 0` and `src = 0` -- a marker, not a quote -- and the prices
> either side of it are continuous and in the same units as the transactions.
> They are quote-feed metadata, which is why they appear for securities the user
> never held, and why Canadian ETFs record one every December with `cshrPre`
> equal to `cshrPost`.

## SP (security prices)

| Field | Description |
|-------|-------------|
| `hsp` | Primary key, monotonic |
| `hsec` | FK to `SEC` |
| `dt` | Price date |
| `dPrice` | Price per unit |
| `hss` | FK to `SEC_SPLIT` when this row records a split |

Duplicate `(hsec, dt)` pairs are normal -- an intraday quote and a close, or a
re-fetch. Deduplicate keeping the highest `hsp`, which is the most recently
written row.

This is the largest table in a real file: 68,000 rows in the 30-year Money Plus
file the importer was built against.

## BILL (scheduled transactions)

| Field | Description |
|-------|-------------|
| `hbill` | Primary key |
| `hbillHead` | Series this row belongs to |
| `iinst` | Instance number within the series |
| `lHtrn` | FK to `TRN` -- the template transaction |
| `frq` | Frequency code (below) |
| `cFrqInst` | Interval multiplier |
| `dt` | Due date |
| `dtMax` | Series end date |
| `cInstMax` | Maximum instances |
| `st` | Status |

**`BILL` is an accumulation of instances, not a list of bills.** One row per
occurrence, so a long history holds thousands: 1,844 rows for roughly 20 real
bills in the file the importer was built against. Group by `hbillHead` and
reduce each series to one representative before doing anything else.

> **Correction.** The original records `st = 1` as "active". No file available
> to this project has ever contained a `BILL` row, so no value of `st` has been
> observed and the claim cannot be checked. Monize therefore **filters on
> nothing**: series are selected by date horizon and shape, the raw `st` rides
> along on every candidate, and `npm run mny:inspect` prints its distribution so
> one run against a real file settles it. A plausible-looking constant here
> would be a guess wearing a filter's clothes.

### Frequency codes (`frq`)

| frq | Meaning | Evidence |
|-----|---------|----------|
| 0 | Once | Format reference only |
| 1 | Daily | Format reference only |
| 2 | Weekly | Format reference only |
| 3 | Monthly | Issue #1150: the same file's monthly bills imported monthly |
| 5 | Yearly | Issue #1150: yearly bills imported as `EXACT[5]`, then "every 2 months" |
| 4, 6, 7 | **Unknown** | Claimed yearly / quarterly / semiannual by the original reference, which 5 refutes |

The code alone is not the whole answer: `cFrqInst` multiplies it, and several
combinations land exactly on a distinct recurrence (weekly x 2 is fortnightly,
weekly x 4 is every four weeks, monthly x 3 is quarterly, monthly x 6 is
semiannual). Where no exact equivalent exists, fall to the next **shorter**
period, which is the safer error: an extra reminder is noise, a missed one is a
missed payment.

> **Correction.** The proof of concept mapped bimonthly (every two months) to
> fortnightly and semiannual to yearly -- errors in both directions at once.

> **Correction.** The original recorded 4 as yearly, 5 as every two months, 6 as
> quarterly and 7 as semiannual. Issue #1150 reported a Money Plus Sunset file
> whose **yearly** bills imported recurring every two months -- which is code 5
> under that table -- while the same file's monthly bills were right. So 5 is
> yearly, 3 is monthly, and the reference is wrong above 3; 4, 6 and 7 now map
> to nothing and are reported (`unusableBill`, carrying `frq` and `cFrqInst`)
> rather than guessed. The gap is narrower than it looks, because `cFrqInst` is
> a real multiplier: every two months, quarterly and twice a year are `frq` 3
> with an interval of 2, 3 and 6.

**A series' own instance dates outrank its code.** `BILL` holds one row per
occurrence, so the spacing between a series' `dt` values *is* its recurrence --
measured on the file in hand, where `frq` is a table nobody has been able to
check. `map/bill-cadence.ts` reads it (a strict majority of the recent gaps
matching one cadence within 12%), and `map-bills.ts` prefers that answer to
`frq`, falling back to the code only for a series too short to measure. Issue
#1150 is the cost of the other order: every affected file stated "365 days
apart" in data nothing was reading.

## Limitations of this reference

- Written against a small corpus. The five committed sample files
  (`backend/src/import/mny/__fixtures__/`) are portfolio-only: no banking
  transactions, no `BILL` rows, and only `act` 0, 1 and 15. Everything outside
  that is either from the original analysis of one large real file, or unverified.
- Explicitly unresolved: the active values of `BILL.st`, and the real-world
  meaning of `act` 5 and `act` 14. Each needs one run of `npm run mny:inspect`
  against a large real file.
- Money's tables carry far more than the importer reads. Budgets (`BGT*`),
  savings goals, classifications and attachments are all out of scope, and are
  not described here.
