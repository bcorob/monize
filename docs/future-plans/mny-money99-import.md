# Money 97-99 `.mny` import: plan

> Companion to [`mny-money99-import-tasks.md`](./mny-money99-import-tasks.md). Extends the native importer described in `docs/specs/mny-import.md` and `backend/src/import/mny/README.md`; read both first.

## Goal

A user with a Microsoft Money 97, 98 or 99 file uploads it to the existing `.mny` wizard and it imports, with no conversion step. Today `readMnyFileHeader` rejects it with `mnyUnsupportedVersion` ("open and save it in Money Plus Sunset").

The community workaround (catrucho/Money-import on GitHub, Python) converts Money 99 into a Sunset file by copying rows into a blank Sunset template, translating codes on the way. Monize does not port the converter: it reads the old file directly and teaches the existing mappers what the Money 99 codes mean. The converter is used only as a source of hypotheses, and every one of them is re-measured below.

## Evidence

Two Money 99 (Spanish locale) files built by hand for this work, the second a superset of the first, 102 `TRN` rows, with the Money 99 account list as ground truth. Every claim in this plan was measured on them by reading the file with `mdb-reader` and running the existing readers and mappers on it with the version check bypassed. They are small: a claim marked **measured** held on every relevant row, but on a handful of rows, so the README's rule stands -- a real file can still contradict a mask.

## What already works (measured)

- `mdb-reader` 3.2.0, already a dependency, reads Jet 3: 2 KB pages, cp1252 text, every table. No decryption step; `msisam/msisam-decrypt.ts` does not apply.
- "No date" is year 10000, as in later versions; `toDate` handles it.
- `readMnyTables` reads accounts, payees, categories, transfers, splits, lots, prices, security splits and currencies. `TRN.hpay` is already an alias of `lHpay`.
- `DHD.hcrncDef` is the base currency, as in later versions (USD in the test file; accounts without a currency display in it).
- Investment `TRN.amt` sign convention matches Money Plus (buy positive, sale negative).
- Account types (`at` 0, 1, 5, 6), the investment account / cash companion pair (`hacctRel`) and loan amortisation history import unchanged; the loan balance reconciles (-4,209.39).

## What differs (measured)

### File header

Engine name `Standard Jet DB`, version byte 0 -- the same signature as an Access 97 `.mdb`. A file is a Money file only if it also has the `ACCT`, `TRN` and `DHD` tables.

### `TRN.grftt`: a different bit layout

| Meaning | Money 99 | Money Plus | Evidence (Money 99) |
|---|---|---|---|
| Voided | `0x80` | `0x100` | row "Salary voided", the only one carrying it |
| Row in a loan account | `0x1` | `0x80` | every row whose `hacct` is the loan account |
| Loan-payment template family | `0x100` | `0x4000` | the account-less `ps = 5` parent, its legs and the leg's counterpart, and nothing else |
| Scheduled instance never posted | `0x400` | `0x60000` | every `frq = -1` row whose `htrnSrc` names a template, and nothing else |
| Member of a scheduled series | `0x200` | `0x200000` | every template and every pending instance |
| Transfer / receiving side | `0x4` / `0x8` | not read | `TRN_XFER` membership |
| Split parent / child | `0x20` / `0x40` | not read | `TRN_SPLIT` membership |

The collision is the defect: Money 99's loan-template bit is Plus's VOID bit, and Money 99's void bit is Plus's loan-account bit. Applying the Plus masks imports voided rows as live (Chase Bank +2,000.00) and imports pending scheduled instances as posted future rows.

### `TRN.act`: a different code table

| Money 99 `act` | Meaning | Monize action | Evidence |
|---|---|---|---|
| 0 | Buy | `BUY` | `LOT.htrnBuy`, 3 rows |
| 1 | Sell | `SELL` | `LOT.htrnSell`, 2 rows |
| 2 | Interest | `INTEREST` | third file: a bond and a CD, each paired with its cash row, booked to Investments:Interest, no `TRN_INV` row |
| 4 | Dividend | `DIVIDEND` | memo + `TRN_XFER` cash pairing |
| 5 | Reinvest dividend | `REINVEST` | `LOT.htrnBuy`; confirmed by the file's author |
| 12 | Other income | see decision D2 | memo + cash pairing |
| 13 | Other expenses | see decision D2 | memo + cash pairing |
| 14 | Capital gains (cash) | `CAPITAL_GAIN` | confirmed by the file's author; cash pairing |
| 15 | Add shares | `ADD_SHARES` | `LOT.htrnBuy` |
| 16 | Remove shares | `REMOVE_SHARES` | `LOT.htrnSell` |
| 19, 20, 22 | Employee stock option grant / vest / expiry | none (decision D3) | zero-amount rows on the option security, in the options account |

Codes 1, 2, 4 and 5 mean different things in Money Plus (buy, sell, interest, an unconfirmed reinvest variant), so one table cannot serve both. Not observed: short sale, cover short, return of capital, and codes 3, 6-11, 17, 18, 21. Money 99's action list shows short sale and cover after "Quitar acciones", which suggests 17 and 18; that is a guess and stays unmapped. Unmapped codes keep today's behaviour: `unknownInvestmentAction`, row skipped.

### Scheduled bills

There is no `BILL` table. A series is a `TRN` template (`frq != -1`) whose `htrnSrc` names its pending instance; a scheduled transfer stores both legs as templates, and only the originating leg carries `0x800`. `frq` / `cFrqInst` look like the Plus values (3/1 monthly in every case observed).

### Ground truth

Money 99's account list for the second file, and what the importer must reproduce once the masks and actions are right. Money's list includes future-dated **posted** rows and excludes pending instances.

| Account | Money 99 | Mapper today |
|---|---|---|
| Chase Bank | 2,105.00 EUR | void row counted, pending rows counted |
| Chase Credit card | -185.00 EUR | -185.00 |
| Chase Investmen (cash) | 22,658.00 EUR | -77,842.00 (sales read as buys) |
| Chase Savings | 11,010.00 EUR | 11,010.00 |
| Loan | -4,209.39 USD | -4,209.39 |
| Holdings | 11 AMZN, 0 of the option security | 13 and 200 (mismatch) |

The test file's EUR->USD rate is 112 (the author's typo), so cross-currency trade prices come out at 112x. That is the file's data, not a defect; tests assert quantities, cash and balances, never converted prices.

## Design

- **Detection.** `readMnyFileHeader` accepts `Standard Jet DB` with version byte 0 and reports a `format` of `jet3` (`msisam` for everything today). Decryption is skipped for `jet3`. `openDatabase` rejects a `jet3` file without `ACCT`, `TRN` and `DHD` as `MnyNotAMoneyFileError`. The staged bytes need no change: a `jet3` file was never encrypted, so `openDecryptedMnyFile` reads it the same way. `MnyDatabase` gains `format`.
- **Flags are translated in the reader.** `readTransactionData` rebuilds a Money 99 `grftt` into the Money Plus layout from the measured bits only (never passing unknown bits through, since they collide). `isVoided`, `isUnpostedRow` and `isLoanPaymentTemplate` stay as they are. Rationale: the README already puts version differences (column aliases) in the reader spec, and the meanings are identical, only the bits move.
- **Actions are looked up per format.** The meanings do not line up (Money 99 has other income and expense; Plus's 12 is a contribution), so translating into Plus codes would launder an unconfirmed Plus meaning onto a confirmed Money 99 one. `MnyTransactionData` carries the format; `mapInvestmentAction`, `MNY_UNCONFIRMED_ACTIONS` and `hasInvestmentDetail` take it.
- **Bills** come from `TRN` templates when the file has no `BILL` table: one candidate per series, the originating leg of a scheduled transfer only, through the existing `mapBills` cadence and roll-forward rules. The reader drops the `0x800` origin bit with every other unmeasured one, so the originating leg is told apart by `TRN.htrnSrc`, which only it carries (templates 1 and 65 name their pending instance; their receiving legs 2 and 66 name nothing).

## Decisions (agreed 2026-10-27)

- **D1 Fixture.** The second test file is committed as `backend/src/import/mny/__fixtures__/sample-money99.mny` (1.2 MB, fabricated data), with its author's permission.
- **D2 Other income / other expenses (`act` 12, 13).** Money's cash-companion row imports as an ordinary categorized transaction in the cash account, taking the investment row's category, and no investment transaction is created. Monize has no misc-income action; the QIF importer maps both to `INTEREST`, which records an expense as income. A row with no cash partner stays an `unknownInvestmentAction`.
- **D3 Employee stock options (`act` 19, 20, 22).** Skipped, each with a `stockOptionNotImported` warning rather than `unknownInvestmentAction`. They move no cash and no shares.
- **D4 Legacy euro currencies (DEM, ESP, FRF and the rest).** Out of scope until a file shows how Money 99 stores them. The converter relabels them as EUR, saying Money 99 quoted them numerically in euros; neither test file has one.

## The first real file (2026-10-27)

The second test file's author imported their own Money 99 file and rebuilt each thing it raised in a third copy, `sample-money99-investments.mny` (a superset of the second; its expected balances are the sums of Money's register rows per account until Money 99's account list for it arrives).

- **`act` 2 is interest** (table above); 19 rows in the real file were skipped as unknown.
- **A CD is bought by amount.** Its `TRN_INV` row carries neither `qty` nor `dPrice` and it opens no `LOT`; in the real file the CD rows had no `TRN_INV` row at all. Money Plus stores the same purchase as units of 1 (`sample-cd-redemption.mny`), so a Money 99 purchase with no units imports as its principal (total less commission) at price 1.
- **Recording a split rewrites the trades before it.** Between the second and third files the only AMZN change is a second 1:2 split, and every AMZN `TRN_INV.qty` and `LOT.qty` doubled while every `TRN_INV.dPrice` and quote halved. The quantities read are already split-adjusted, so `securitySplitNotApplied` is not raised for a Money 99 file.
- **Five columns are absent from every Money 99 file** (`CRNC.fHidden`, `CRNC_EXCHG.fHist`, `ACCT.fWatch`, `TRN.hbillHead`, `TRN_INV.amtInt`) and their defaults are what Money 99 means, so they raise no `missingField` warning.
- **A skipped trade's cash row was lost.** The cash row in the trade's own sleeve was wired to a synthesized counterpart in that same sleeve, netting it to zero; the third file's cash account came out 11.00 short (its two interest rows). Such a row now imports on its own, with the investment row's category.
- **A trade the file cannot convert takes the market rate.** `CRNC_EXCHG` holds one rate per pair, dated when it was last edited, so a trade of a foreign-quoted security before that date has no rate on or before it (`resolveFxRate`); 101 rows in the real file stayed in the account's currency. `MnyMarketRateService` now looks each pair and date up in Monize's rate history and, for what that lacks, one provider window per pair, and re-parses with the answers (`crossCurrencyTradeMarketRate`). A trade neither source covers still stays unconverted.
- **Not changed:** a loan payment with two or more non-principal category legs still leaves the interest category unset (`loanInterestCategoryUnclear`); the third file's split payment names one, so the real file's shape is not yet known. The real file's `act` 12 and 14 rows were reported as `unconfirmedInvestmentAction`, which no Money 99 code raises on `main`.

## Out of scope

Budgets (Monize does not import them from any `.mny`), stripping a leading `_` from security names (one user's naming habit), the converter's account merge and link options, and a password-protected Money 99 file (the converter's author reports the password encrypts nothing; untested).
