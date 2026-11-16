import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";

/**
 * Microsoft Money 97-99 coded values.
 *
 * Money 97-99 write a Jet 3 database, and the code spaces in it are not the
 * Money 2001+ ones: the `TRN.grftt` bits sit in different places and the
 * `TRN.act` table is numbered differently. Where they collide they collide
 * dangerously -- Money 99's loan-template bit is Money Plus's VOID bit, its
 * void bit is Money Plus's loan-account bit, and its SELL is Money Plus's
 * BUY. Nothing here may be read through the Money Plus tables.
 *
 * Every value is **measured** on two hand-built Money 99 (Spanish locale)
 * files, against facts the file settles itself (`LOT.htrnBuy` /
 * `htrnSell`, `TRN_XFER` and `TRN_SPLIT` membership, the account a row sits
 * in) and against the author's own record of what each row was entered as.
 * The files are small, so a real file may still add a bit or a code; the
 * evidence is in `docs/future-plans/mny-money99-import.md`.
 */

/** Which on-disk format a `.mny` file is: Money 2001+ or Money 97-99. */
export type MnyFileFormat = "msisam" | "jet3";

/** `TRN.grftt` bits as Money 97-99 write them. */
export const MONEY99_TRANSACTION_FLAG = {
  /** The row sits in a loan account: every row of the loan account, nothing else. */
  DEBT_ACCOUNT: 0x1,
  /** Voided: the one row entered as voided, `cs = 2`. Money Plus uses 0x100. */
  VOID: 0x80,
  /**
   * The loan-payment template family: the account-less `ps = 5` split parent,
   * its legs and the legs' counterpart in the loan account, and nothing else.
   */
  LOAN_PAYMENT_TEMPLATE: 0x100,
  /** Every recurrence template and every pending instance of one. */
  SCHEDULED_SERIES: 0x200,
  /**
   * A scheduled instance Money holds but never posted: every `frq = -1` row a
   * template's `htrnSrc` names, and nothing else. Not in Money's register or
   * its balance.
   */
  UNPOSTED: 0x400,
} as const;

/**
 * Money Plus `TRN.grftt` bits for the same meanings, from
 * `MNY_TRANSACTION_FLAG`. Restated rather than imported to keep this file free
 * of a cycle with `mny-model.ts`; `mny-money99.spec.ts` asserts the two agree.
 */
const MONEY_PLUS_FLAG_FOR: ReadonlyArray<readonly [number, number]> = [
  [MONEY99_TRANSACTION_FLAG.DEBT_ACCOUNT, 0x80],
  [MONEY99_TRANSACTION_FLAG.VOID, 0x100],
  [MONEY99_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE, 0x4000],
  [MONEY99_TRANSACTION_FLAG.SCHEDULED_SERIES, 0x200000],
  [MONEY99_TRANSACTION_FLAG.UNPOSTED, 0x60000],
];

/**
 * Rewrites a Money 99 `grftt` into the Money Plus layout the mappers read.
 *
 * Only the measured bits are carried; every other bit is dropped. Passing an
 * unknown bit through is not neutral here: the two layouts overlap, so a
 * Money 99 bit left in place lands on whatever Money Plus means by it.
 */
export function translateMoney99Flags(flags: number): number {
  let translated = 0;
  for (const [money99, moneyPlus] of MONEY_PLUS_FLAG_FOR) {
    if ((flags & money99) !== 0) {
      translated |= moneyPlus;
    }
  }
  return translated;
}

/** Money 97-99 `TRN.act` codes. */
export const MONEY99_ACTION = {
  /** Opens a lot (`LOT.htrnBuy`). */
  BUY: 0,
  /** Closes a lot (`LOT.htrnSell`). Money Plus's 1 is BUY. */
  SELL: 1,
  /**
   * Interest paid to the cash account: on a bond and on a CD, each paired with
   * its cash row through `TRN_XFER`, booked to Investments:Interest, no
   * `TRN_INV` row. Money Plus's 2 is SELL.
   */
  INTEREST: 2,
  /** Cash dividend paid to the cash account; no `TRN_INV` row. */
  DIVIDEND: 4,
  /** Reinvested dividend: opens a lot, no cash pairing. */
  REINVEST: 5,
  /** "Otros ingresos": cash in through the cash account; no shares. */
  OTHER_INCOME: 12,
  /** "Otros gastos": cash out through the cash account; no shares. */
  OTHER_EXPENSE: 13,
  /** "Beneficios del capital": a cash capital-gain distribution. */
  CAPITAL_GAIN: 14,
  /** Opens a lot with no cash. */
  ADD_SHARES: 15,
  /** Closes a lot with no cash. Never a sale. */
  REMOVE_SHARES: 16,
  /** Employee stock option grant: zero amount, on the option security. */
  OPTION_GRANT: 19,
  /** Employee stock option vesting: zero amount, one row per vesting date. */
  OPTION_VEST: 20,
  /** Employee stock option expiry: zero amount. */
  OPTION_EXPIRE: 22,
} as const;

export const MONEY99_ACTION_BY_CODE: ReadonlyMap<number, InvestmentAction> =
  new Map([
    [MONEY99_ACTION.BUY, InvestmentAction.BUY],
    [MONEY99_ACTION.SELL, InvestmentAction.SELL],
    [MONEY99_ACTION.INTEREST, InvestmentAction.INTEREST],
    [MONEY99_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
    [MONEY99_ACTION.REINVEST, InvestmentAction.REINVEST],
    [MONEY99_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
    [MONEY99_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
    [MONEY99_ACTION.REMOVE_SHARES, InvestmentAction.REMOVE_SHARES],
  ]);

/** Codes whose amount is on `TRN.amt` alone, with no `TRN_INV` row. */
export const MONEY99_CASH_ONLY_ACTIONS: ReadonlySet<number> = new Set([
  MONEY99_ACTION.INTEREST,
  MONEY99_ACTION.DIVIDEND,
  MONEY99_ACTION.OTHER_INCOME,
  MONEY99_ACTION.OTHER_EXPENSE,
  MONEY99_ACTION.CAPITAL_GAIN,
]);

/**
 * Other income and other expenses. Monize has no investment action for either,
 * so the reader imports the cash account's side of the pair as an ordinary
 * categorized transaction instead (`collapseMoney99CashPairs`).
 */
export const MONEY99_CASH_PAIR_ACTIONS: ReadonlySet<number> = new Set([
  MONEY99_ACTION.OTHER_INCOME,
  MONEY99_ACTION.OTHER_EXPENSE,
]);

/**
 * Columns the readers ask for that Money 97-99 never wrote, as
 * `<table>.<field>` (`missingFields`). Absent from every Money 99 file seen,
 * and the reader's default is what Money 99 means by leaving them out:
 * nothing is hidden, watched or a historical rate, a bill series is read
 * from `TRN` templates (`money99-bills.ts`), and accrued interest is not
 * recorded. Reporting them would tell the user about something they cannot
 * change.
 */
export const MONEY99_ABSENT_FIELDS: ReadonlySet<string> = new Set([
  "CRNC.hidden",
  "CRNC_EXCHG.historical",
  "ACCT.watch",
  "TRN.billSeries",
  "TRN_INV.interest",
]);

/** Employee stock option events. They move no cash and no shares. */
export const MONEY99_STOCK_OPTION_ACTIONS: ReadonlySet<number> = new Set([
  MONEY99_ACTION.OPTION_GRANT,
  MONEY99_ACTION.OPTION_VEST,
  MONEY99_ACTION.OPTION_EXPIRE,
]);
