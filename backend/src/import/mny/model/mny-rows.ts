/**
 * Typed rows read out of a Money file.
 *
 * Field names are descriptive; the Money column each one comes from is named
 * in its comment, so this file doubles as the translation table between the
 * format reference (which speaks `hacct`, `grftt`, `lHpay`) and the mappers.
 * Only the columns the import actually needs appear here -- `ACCT` alone has
 * 124 of them.
 *
 * Handles are `number | null`: Money writes null, 0 or -1 for "no reference"
 * depending on the release. Dates are `YYYY-MM-DD` strings or null, matching
 * the repository's DATE convention. Amounts are numbers already rounded to
 * four decimal places.
 */

/** `DHD` -- one row of file-wide defaults. */
export interface MnyFileDefaults {
  /** `hcrncDef`: the file's base currency. GBP in money2002, USD in money2008. */
  readonly defaultCurrency: number | null;
  /** `hcrncCur`: currency of the active view. Null in every sample file. */
  readonly displayCurrency: number | null;
  /** `lcid`: Windows locale the file was created under. */
  readonly localeId: number;
}

/** `CRNC` -- currencies, including the pseudo-entries Money uses internally. */
export interface MnyCurrency {
  /** `hcrnc` */
  readonly handle: number | null;
  /** `szIsoCode`, e.g. "GBP". */
  readonly isoCode: string;
  /** `szName`, e.g. "British pound". */
  readonly name: string;
  /** `szSymbol`, e.g. "/GBPUS". Money's quote symbol, not a display symbol. */
  readonly quoteSymbol: string;
  /** `fHidden`. Absent before Money Plus, where it reads false. */
  readonly hidden: boolean;
}

/** `CRNC_EXCHG` -- exchange rates, current and historical. */
export interface MnyExchangeRate {
  /** `hcrncFrom` */
  readonly fromCurrency: number | null;
  /** `hcrncTo` */
  readonly toCurrency: number | null;
  /** `rate` */
  readonly rate: number;
  /** `dt` */
  readonly date: string | null;
  /** `fHist`: true for a historical point, false for the live rate. */
  readonly historical: boolean;
}

/** `ACCT` -- accounts of every kind, including closed ones. */
export interface MnyAccount {
  /** `hacct` */
  readonly handle: number | null;
  /** `at`: 0 bank, 1 credit card, 2 cash, 3 asset, 4 loan, 5 investment, 6 mortgage. */
  readonly type: number;
  /** `szFull` */
  readonly name: string;
  /** `hacctRel`: the paired cash/brokerage account of an investment account. */
  readonly relatedAccount: number | null;
  /** `hcrnc` */
  readonly currency: number | null;
  /** `amtOpen` */
  readonly openingBalance: number;
  /** `amtLimit`: credit limit, for card and line-of-credit accounts. */
  readonly creditLimit: number;
  /** `dtOpen` */
  readonly openedOn: string | null;
  /** `dtClose` */
  readonly closedOn: string | null;
  /** `fClosed`. The only closure signal -- account names are not one. */
  readonly closed: boolean;
  /** `fFavorite` */
  readonly favourite: boolean;
  /** `mComment` */
  readonly comment: string | null;
}

/** `PAY` -- payees. */
export interface MnyPayee {
  /** `hpay` */
  readonly handle: number | null;
  /** `szFull` */
  readonly name: string;
  /** `fHidden` */
  readonly hidden: boolean;
}

/** `CAT` -- the category tree. */
export interface MnyCategory {
  /** `hcat` */
  readonly handle: number | null;
  /** `szFull` */
  readonly name: string;
  /** `hcatParent`: null only for the two roots, INCOME and EXPENSE. */
  readonly parent: number | null;
  /** `nLevel`: 0 for the roots. Sort by this so parents precede children. */
  readonly level: number;
  /** `lType`: Money's classification code. Not a clean income flag. */
  readonly categoryType: number;
  /** `fTax` */
  readonly taxRelated: boolean;
}

/** `SEC` -- securities. `sct` 4 rows are currency pseudo-securities. */
export interface MnySecurity {
  /** `hsec` */
  readonly handle: number | null;
  /** `szSymbol` */
  readonly symbol: string;
  /** `szFull` */
  readonly name: string;
  /** `sct`: security type. 4 is a currency, 7 an index. */
  readonly securityType: number;
  /** `hcrnc` */
  readonly currency: number | null;
  /** `fHidden` */
  readonly hidden: boolean;
}

/**
 * `SEC_SPLIT` -- stock splits. The table carries no security handle: rows are
 * reached through `MnySecurityPrice.split`.
 */
export interface MnySecuritySplit {
  /** `hss` */
  readonly handle: number | null;
  /** `cshrPre`: shares before the split. */
  readonly sharesBefore: number;
  /** `cshrPost`: shares after the split. */
  readonly sharesAfter: number;
  /** `dtRecord` */
  readonly recordDate: string | null;
  /** `dPriceSplit` */
  readonly price: number;
}

/** `SP` -- security price history. */
export interface MnySecurityPrice {
  /** `hsp` */
  readonly handle: number | null;
  /** `hsec` */
  readonly security: number | null;
  /** `dt` */
  readonly date: string | null;
  /** `dPrice` */
  readonly price: number;
  /** `hss`: the `SEC_SPLIT` row this price belongs to, when any. */
  readonly split: number | null;
}

/** `TRN` -- every transaction, including split children and bill templates. */
export interface MnyTransaction {
  /** `htrn` */
  readonly handle: number | null;
  /** `hacct` */
  readonly account: number | null;
  /** `hacctLink`: the counterpart account of a transfer. */
  readonly linkedAccount: number | null;
  /** `lHpay` in Money Plus, `hpay` before it. */
  readonly payee: number | null;
  /** `hcat` */
  readonly category: number | null;
  /** `hsec` */
  readonly security: number | null;
  /** `dt` */
  readonly date: string | null;
  /** `amt`, in the account's currency. */
  readonly amount: number;
  /** `cs`: 0 unreconciled, 1 cleared, 2 reconciled. */
  readonly clearedStatus: number;
  /** `grftt`: flag word. 0x100 voided, 0x80 a loan/mortgage row. See `MNY_TRANSACTION_FLAG`. */
  readonly flags: number;
  /** `act`: investment action code. See section 8.4 of the design. */
  readonly action: number;
  /**
   * `frq`: -1 on a real posting. Anything else marks a recurrence template,
   * which is the whole phantom-row rule -- auto-entered rows are real.
   */
  readonly frequency: number;
  /** `szId`: cheque or reference number. */
  readonly reference: string | null;
  /** `mMemo` */
  readonly memo: string | null;
  /** `hbillHead`: the bill series this row was posted from. Money 2002+. */
  readonly billSeries: number | null;
}

/** `TRN_SPLIT` -- which transactions are children of which. */
export interface MnyTransactionSplit {
  /** `htrn`: the child transaction. */
  readonly child: number | null;
  /** `htrnParent`: the transaction the child belongs to. */
  readonly parent: number | null;
  /** `iSplit`: position within the parent. */
  readonly position: number;
}

/** `TRN_XFER` -- authoritative transfer pairs. No name matching needed. */
export interface MnyTransfer {
  /** `htrnFrom` */
  readonly from: number | null;
  /** `htrnLink` */
  readonly to: number | null;
}

/**
 * `TRN_INV` -- the investment detail of a transaction. Dividends (`act` 4)
 * have no row here at all; their amount lives on the `TRN` row.
 */
export interface MnyInvestmentDetail {
  /** `htrn` */
  readonly transaction: number | null;
  /** `dPrice` */
  readonly price: number;
  /** `qty`: always positive. Direction comes from `act`, never from a sign. */
  readonly quantity: number;
  /** `amtCmn`: commission. */
  readonly commission: number;
  /** `amtInt`: accrued interest. */
  readonly interest: number;
}

/** `LOT` -- open and closed tax lots, the authoritative holdings source. */
export interface MnyLot {
  /** `hlot` */
  readonly handle: number | null;
  /** `hacct` */
  readonly account: number | null;
  /** `hsec` */
  readonly security: number | null;
  /** `qty` */
  readonly quantity: number;
  /** `htrnBuy` */
  readonly buyTransaction: number | null;
  /** `htrnSell`: null while the lot is still open. */
  readonly sellTransaction: number | null;
  /** `dtBuy` */
  readonly boughtOn: string | null;
  /** `dtSell` */
  readonly soldOn: string | null;
}

/** `BILL` -- scheduled bills and deposits. Absent before Money 2002. */
export interface MnyBill {
  /** `hbill` */
  readonly handle: number | null;
  /** `st`: series status. Active semantics pinned by task M0.6. */
  readonly status: number;
  /**
   * `frq`: the unit the recurrence is counted in -- 0 once, 1 daily, 2 weekly,
   * 3 monthly, 4 quarterly, 5 yearly (`MNY_FREQUENCY`). The cadence is this
   * paired with `occurrencesPerUnit`, never `frq` alone.
   */
  readonly frequency: number;
  /**
   * `cFrqInst`: how many times the bill falls due per one `frequency` unit --
   * a rate, so 2 on a monthly unit is twice a month and 0.5 is every other
   * month. Fractional in real files; never an interval multiplier.
   */
  readonly occurrencesPerUnit: number;
  /** `dt`: next due date. */
  readonly nextDue: string | null;
  /** `lHtrn`: the template `TRN` row this bill posts from. */
  readonly templateTransaction: number | null;
  /** `hbillHead`: the series a row belongs to; the dedupe key. */
  readonly series: number | null;
  /** `iinst`: instance number within the series. */
  readonly instance: number;
  /** `dtMax`: last date the series runs to, when bounded. */
  readonly endsOn: string | null;
  /** `cInstMax`: number of instances the series runs for, when bounded. */
  readonly maxInstances: number;
}
