import { AccountType } from "../../../accounts/entities/account.entity";
import { FREQUENCY_CYCLE_DAYS } from "../../../common/recurrence";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";

/**
 * Microsoft Money's coded values, and how they map onto Monize's domain.
 *
 * Every constant here is either **confirmed** against the committed fixtures
 * (see `mny-model.spec.ts`, which asserts the fixture evidence) or carried
 * over from PR #192's reverse-engineered format reference and marked
 * **unconfirmed**. Nothing is guessed silently: an unconfirmed code that turns
 * up in a real file must surface as a warning rather than a mapping.
 *
 * Mappers own the row-level rules (which rows are phantoms, how transfers
 * pair). This file owns only code-to-meaning lookups over a single value.
 */

// ---------------------------------------------------------------------------
// Accounts (`ACCT.at`)
// ---------------------------------------------------------------------------

/**
 * Money account types. **Unconfirmed beyond 0 and 5** -- the sample files only
 * contain investment accounts and their paired cash accounts. The rest come
 * from PR #192's format reference.
 */
export const MNY_ACCOUNT_TYPE = {
  BANK: 0,
  CREDIT_CARD: 1,
  CASH: 2,
  ASSET: 3,
  LOAN: 4,
  INVESTMENT: 5,
  MORTGAGE: 6,
} as const;

const ACCOUNT_TYPE_BY_CODE: ReadonlyMap<number, AccountType> = new Map([
  [MNY_ACCOUNT_TYPE.BANK, AccountType.CHEQUING],
  [MNY_ACCOUNT_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
  [MNY_ACCOUNT_TYPE.CASH, AccountType.CASH],
  [MNY_ACCOUNT_TYPE.ASSET, AccountType.ASSET],
  [MNY_ACCOUNT_TYPE.LOAN, AccountType.LOAN],
  [MNY_ACCOUNT_TYPE.INVESTMENT, AccountType.INVESTMENT],
  [MNY_ACCOUNT_TYPE.MORTGAGE, AccountType.MORTGAGE],
]);

/**
 * The Monize account type for a Money `at` code, or null when the code is
 * unknown. Money has no separate savings type, so bank accounts land on
 * CHEQUING; the wizard lets the user change it.
 */
export function mapAccountType(at: number): AccountType | null {
  return ACCOUNT_TYPE_BY_CODE.get(at) ?? null;
}

// ---------------------------------------------------------------------------
// Transactions (`TRN.cs`, `TRN.grftt`, `TRN.frq`)
// ---------------------------------------------------------------------------

/** Reconciliation state. Confirmed: every fixture row is 0. */
export const MNY_CLEARED_STATUS = {
  UNRECONCILED: 0,
  CLEARED: 1,
  RECONCILED: 2,
} as const;

const STATUS_BY_CODE: ReadonlyMap<number, TransactionStatus> = new Map([
  [MNY_CLEARED_STATUS.UNRECONCILED, TransactionStatus.UNRECONCILED],
  [MNY_CLEARED_STATUS.CLEARED, TransactionStatus.CLEARED],
  [MNY_CLEARED_STATUS.RECONCILED, TransactionStatus.RECONCILED],
]);

/**
 * Bits of the `TRN.grftt` flag word.
 *
 * Every bit here is **measured** against the maintainer's Money Plus file
 * (53,079 `TRN` rows across 56 accounts) by cross-tabbing the bit against facts
 * the file already settles -- which account a row sits in, whether it appears in
 * `TRN_SPLIT` or `TRN_XFER`, whether it carries `hsec`, what its memo says. The
 * committed fixtures are far too small to see any of this: their rows carry only
 * 0x2, 0x10, 0x40 and 0x86.
 *
 * The bits, with the measurement that fixes each:
 *
 * | Mask | Meaning | Evidence |
 * |------|---------|----------|
 * | 0x2, 0x4 | Transfer side | 100% of both appear in `TRN_XFER` |
 * | 0x10 | Investment row | 100% carry `hsec` |
 * | 0x20 | Split parent | 100% appear in `TRN_SPLIT.htrnParent` |
 * | 0x40 | Split child | 100% appear in `TRN_SPLIT.htrn` |
 * | 0x80 | Row sits in a debt account | 1,239 rows, **all** in the 12 loan and mortgage accounts, and every row in those accounts has it |
 * | 0x100 | Voided | 31 rows, all `cs = 2`, half of them zero-amount, and their memos name a cancelled or never-presented cheque |
 * | 0x4000 | Loan-payment template | 50 rows, which is **exactly** the ten account-less `ps = 5` split parents plus their legs and those legs' transfer counterparts -- set equality in both directions, and one family per loan or mortgage account |
 * | 0x200000 | Member of a scheduled series | 4,653 of 4,692 are `frq != -1` templates, and no template lacks it |
 *
 * Only the two Monize acts on are exported; the rest are documented here and in
 * `docs/ms-money-data-model.md` so the next reader does not have to re-measure.
 */
export const MNY_TRANSACTION_FLAG = {
  /**
   * Transaction is voided. Monize imports it with status VOID.
   *
   * PR #192's format reference called this 0x80, and 0x80 is the bit every loan
   * and mortgage payment carries -- so **every loan payment imported as VOID**,
   * and because `computeExpectedBalances` skips voided rows, every loan and
   * mortgage balance sat frozen at its opening balance. 1,084 of the
   * maintainer's 33,734 transactions came in voided; the true count is 31.
   */
  VOID: 0x100,
  /**
   * The row belongs to a loan or mortgage account. Purely informational: which
   * account a row is in already says this, and nothing keys off the bit. It is
   * named so the 0x80-is-void mistake cannot be made again silently.
   */
  DEBT_ACCOUNT: 0x80,
  /**
   * The row is part of a loan-payment template -- Money's definition of the
   * next scheduled payment for a loan or mortgage, which the register never
   * shows.
   *
   * Money keeps one such family per debt account: a split parent with **no
   * `hacct` at all**, its principal/interest legs, and the legs' transfer
   * counterparts sitting in the loan account. `BILL.lHtrn` does not reference
   * them, so the bill-template filter never saw them.
   *
   * Only the parent was being skipped, and only because a row with no account
   * is unusable. The legs' counterparts kept their account and their date, so
   * they imported as ordinary principal postings that no payment ever funded:
   * twelve phantom rows adding $9,902.63 across seven of the maintainer's debt
   * accounts. The bit catches the whole family in one test.
   */
  LOAN_PAYMENT_TEMPLATE: 0x4000,
  /**
   * The row is a scheduled instance Money holds but **never posted**: it is not
   * in the register and not in the balance. Either bit of the mask marks one;
   * they occur alone and together, and all 67 rows carrying them behave alike.
   *
   * Measured, and then confirmed against Money itself. In the maintainer's file
   * all 67 are unreconciled where the file is 74% reconciled, all fall in one
   * eleven-month window (2003-10-15 to 2004-09-28), and they sit almost
   * entirely in the two accounts he banked online with. Every one of them also
   * carries `SCHEDULED_SERIES`.
   *
   * Importing them put four accounts out by exactly their total: CIBC Chequing
   * by $7,671.79 against an `ACCT.amtEndRec` of 0.00, CIBC VISA by -$156.55
   * against 0.00, the Standard Life sleeve by $91.00 and Mortgage - 33 Spring
   * by $350.00. `amtEndRec` alone could not settle it -- it is a *reconciled*
   * balance, and these rows are unreconciled, so the two readings predict the
   * same number. The maintainer looked: the rows are not in Money's register,
   * and its ending balance for that account is $0.00.
   */
  UNPOSTED: 0x60000,
  /**
   * The row belongs to a scheduled series. Informational: 4,653 of the 4,692
   * rows carrying it are `frq != -1` templates and no template lacks it, but
   * the 39 that remain are real postings the scheduler entered, so the bit is
   * never a reason to skip a row -- `frq` and `UNPOSTED` decide that.
   */
  SCHEDULED_SERIES: 0x200000,
} as const;

export function isVoided(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.VOID) !== 0;
}

/**
 * True for a scheduled instance Money never posted. Not a warning: the register
 * does not show these rows either, so there is nothing for the user to fix.
 */
export function isUnpostedRow(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.UNPOSTED) !== 0;
}

/**
 * True for a row in a loan or mortgage account. Never a reason to skip a row --
 * these are ordinary postings, and treating the bit as anything else is what
 * this function exists to make obvious.
 */
export function isDebtAccountRow(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.DEBT_ACCOUNT) !== 0;
}

/**
 * The reference (Money's "Num" column) a `TRN.szId` holds, or null for a value
 * Monize has nothing to show.
 *
 * **`szId` packs two fields into one string**: a leading digit saying what kind
 * of reference it is, then the reference itself. Imported whole, it reads as
 * `1Debit` and `0           2` in the register, which is what this exists to
 * stop.
 *
 * - `1` prefixes free text -- `Debit`, `ATM`, `Telebank`, `PC Banking`,
 *   `EComm`. 2,209 rows in the maintainer's file, not one of them numeric.
 * - `0` prefixes a number right-aligned in twelve characters. 1,060 rows, every
 *   one numeric, every one exactly thirteen characters long.
 *
 * A `0` number is dropped for a row in a loan or mortgage account, where it is
 * **Money's instalment counter and not a reference the user wrote**. Two files
 * agree: 657 of those 1,060 sit in debt accounts counting 1, 2, 3 up the
 * payment schedule, and all 461 in Money Plus's own `sample.mny` are the "Home
 * Loan" payment numbers, repeated across each payment's split legs. Neither
 * ever appears on the bank side of the transfer -- the partner row's `szId` is
 * null in all 642 cases -- and Money's loan register has no Num column to show
 * it in. Outside a debt account the same shape is a cheque number, sequential
 * over years against landlords and utilities, and is kept.
 *
 * **Both shapes are matched strictly, and anything else is returned as-is.**
 * A bare `1042` is a cheque number a user typed, not the text `042` behind a
 * kind digit, so the text kind requires a non-digit after the `1` -- which
 * costs nothing, since not one of the 2,209 text references in the file is
 * numeric -- and the number kind requires the padding Money writes. Losing a
 * reference is worse than showing an odd one.
 */
const REFERENCE_TEXT = /^1(\D.*)$/;
const REFERENCE_NUMBER = /^0\s+(\d+)$/;

export function decodeReference(
  raw: string | null,
  flags: number,
): string | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const trimmed = raw.trim();

  const text = REFERENCE_TEXT.exec(raw);
  if (text) {
    return text[1].trim();
  }

  const number = REFERENCE_NUMBER.exec(raw);
  if (number) {
    return isDebtAccountRow(flags) ? null : number[1];
  }

  return trimmed;
}

/**
 * The `BILL.lHtrn` rows that really are recurrence templates.
 *
 * `lHtrn` is not "the template" -- it is whichever transaction the series
 * currently points at, and for a bill that has been *entered* that is the
 * posting itself. Excluding every `lHtrn` row therefore deletes real
 * transactions: 1,843 of the maintainer's 1,845 are `frq != -1` and were never
 * postings anyway, and the other two are a pair of 2003 expense
 * reimbursements -- dated, memoed, `frq = -1` -- whose loss left one chequing
 * account $6,243.96 short.
 *
 * So the row's own `frq` decides, which is the rule the rest of the importer
 * already follows. A handle with no row left in `TRN` stays in the set: absent
 * evidence, the safer reading of a bill's pointer is that it is scaffolding.
 */
export function billTemplateHandles(
  bills: readonly { readonly templateTransaction: number | null }[],
  transactions: readonly {
    readonly handle: number | null;
    readonly frequency: number;
  }[],
): ReadonlySet<number> {
  const frequencyByHandle = new Map<number, number>();
  for (const row of transactions) {
    if (row.handle !== null) {
      frequencyByHandle.set(row.handle, row.frequency);
    }
  }

  const handles = new Set<number>();
  for (const bill of bills) {
    const handle = bill.templateTransaction;
    if (handle === null) {
      continue;
    }
    const frequency = frequencyByHandle.get(handle);
    if (frequency === undefined || isRecurrenceTemplate(frequency)) {
      handles.add(handle);
    }
  }
  return handles;
}

/**
 * True for any row of a loan-payment template family -- parent, leg, or the
 * leg's counterpart in the loan account. Every one of them is scaffolding for
 * the *next* payment, so none is a posting.
 */
export function isLoanPaymentTemplate(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE) !== 0;
}

/** `TRN.frq` on a real posting. Confirmed: every fixture row is -1. */
export const MNY_REAL_POSTING_FREQUENCY = -1;

/**
 * True when the row is a recurrence template rather than a posting. This is
 * the whole phantom-row rule for `frq`: auto-entered rows stay.
 */
export function isRecurrenceTemplate(frequency: number): boolean {
  return frequency !== MNY_REAL_POSTING_FREQUENCY;
}

/**
 * The Monize status for a transaction. Voided wins over the reconciliation
 * state; an unknown `cs` falls back to UNRECONCILED, which is the safe
 * direction (a wrongly-reconciled row hides a real discrepancy).
 */
export function mapTransactionStatus(
  clearedStatus: number,
  flags: number,
): TransactionStatus {
  if (isVoided(flags)) {
    return TransactionStatus.VOID;
  }
  return STATUS_BY_CODE.get(clearedStatus) ?? TransactionStatus.UNRECONCILED;
}

// ---------------------------------------------------------------------------
// Investment actions (`TRN.act`)
// ---------------------------------------------------------------------------

/**
 * Money investment action codes.
 *
 * These are read off `LOT`, which is Money's own record of which transaction
 * opened and closed each tax lot and therefore settles direction without
 * inference: whatever `act` a `LOT.htrnBuy` row carries acquires shares, and
 * whatever `LOT.htrnSell` carries disposes of them. Two independent Money Plus
 * files agree -- the maintainer's (4,616 lots) and the `sample.mny` shipped
 * with Money Plus (41 lots).
 *
 * The previous table came from PR #192's format reference and had **`act` 1 as
 * SELL**, which is backwards: `act` 1 opens 3,520 lots in the maintainer's file
 * and closes none. Every purchase imported as a sale, so no cash ever left a
 * brokerage sleeve, holdings replayed negative, and the investment half of the
 * ledger was pure credit.
 *
 * `act` 0, 5, 14, 15 and 16 appear in no Money Plus file and keep their
 * reference meanings; the fixtures are the only evidence for them (`act` 15
 * opens all 60 of money2002's lots, which is consistent with ADD_SHARES).
 * Where the two schemes disagree the lot evidence wins, because it is
 * measured rather than assumed.
 */
export const MNY_ACTION = {
  /** Money 2001-era buy. No Money Plus file uses it. */
  BUY_LEGACY: 0,
  /** Opens lots, `TRN.amt` positive: the money went out. */
  BUY: 1,
  /** Closes lots, `TRN.amt` negative: the money came in. */
  SELL: 2,
  /** Cash dividend. Has **no** `TRN_INV` row -- the amount is on `TRN.amt`. */
  DIVIDEND: 3,
  /**
   * Money's "Interest" activity: fixed-income interest paid out to a cash
   * account, also without a `TRN_INV` row. Named by the reporter of issue
   * #1149 against Money's own register, which matches Money's QIF vocabulary
   * (`IntInc`); it lands on tax reports as interest, so mapping it to
   * DIVIDEND -- as this table did while the name was unknown -- misfiled it.
   *
   * `TRN.amt` for these rows carries the opposite sign from what Money's UI
   * displays (the same file-side convention that stores a BUY positive), which
   * is why the raw amounts read negative in the preview's flagged rows. The
   * mapper discards the sign and takes direction from the action, so the
   * imported row pays into the cash sleeve regardless.
   */
  INTEREST: 4,
  /** Second reinvestment variant; the 3-versus-5 distinction is unconfirmed. */
  REINVEST_ALT: 5,
  /** Reinvested distribution: opens lots, and the cash never lands. */
  REINVEST: 9,
  /**
   * Money's "Reinvest Interest" activity: interest earned on a CD or bond
   * accrued straight back into the holding, never landing as cash. Named in
   * issue #1149; QIF's `ReinvInt`. Opens no lot in the one file measured,
   * which is consistent with Money not lot-tracking fixed-income accruals.
   */
  REINVEST_INTEREST: 10,
  /**
   * Opens lots for a stated value that **no cash pays for**: units credited to a
   * plan account from outside it. `act` 1 pairs with a cash row through
   * `TRN_XFER` 2,015 times in 2,029 (`act` 3, 1,090 of 1,090); `act` 12 does so
   * 0 times in 92, exactly like the `act` 9 reinvestments beside it, and 82 of
   * those 92 sit in one employer-matched RRSP (`ACCT.fEmpMatch`).
   *
   * Charging its value to the cash sleeve, as `BUY` does, is what left that
   * account $18,457.22 overdrawn where Money's own cash rows net to $91.00 --
   * the whole discrepancy, to the cent, was this code's 74 non-zero amounts.
   */
  CONTRIBUTION: 12,
  /** Closes lots with no cash. */
  REMOVE_SHARES: 13,
  /** Cash corporate action. Real-world meaning unconfirmed. */
  CAPITAL_GAIN: 14,
  /** Opens lots without a cash leg. Half of a cross-account transfer. */
  ADD_SHARES: 15,
  /** Closes lots without a cash leg. **Never** a sale. */
  REMOVE_SHARES_LEGACY: 16,
  /**
   * Money's "S-Term Cap Gains Dist": a short-term capital-gain distribution
   * paid out to a cash account, not reinvested. Issue #1149; QIF `CGShort`.
   */
  ST_CAPITAL_GAINS_DIST: 24,
  /**
   * Money's "L-Term Cap Gains Dist": a long-term capital-gain distribution
   * paid out to a cash account. Issue #1149; QIF `CGLong`.
   */
  LT_CAPITAL_GAINS_DIST: 26,
  /**
   * Money's "Reinvest S-Term CG Dist": a short-term capital-gain distribution
   * bought straight back into the security. Issue #1149; QIF `ReinvSh`.
   */
  REINVEST_ST_CAPITAL_GAINS: 27,
  /**
   * Money's "Reinvest L-Term CG Dist": the long-term twin of `act` 27.
   * Issue #1149; QIF `ReinvLg`.
   */
  REINVEST_LT_CAPITAL_GAINS: 29,
  /**
   * Money's "Redeem CD/Bond": a fixed-income instrument sold back, optionally
   * carrying accrued interest inside its cash figure. Issue #1149. Mapped to
   * Monize's REDEEM (a sale in behaviour), and `TRN.amt` wins as the total
   * (see `totalAmountOf`), so the accrued-interest component is included the
   * same way Money includes it.
   */
  REDEEM_CD_BOND: 30,
  /** Opens lots with no cash: the receiving half of a share transfer. */
  TRANSFER_IN: 32,
  /** Closes lots with no cash: the sending half of a share transfer. */
  TRANSFER_OUT: 33,
} as const;

const ACTION_BY_CODE: ReadonlyMap<number, InvestmentAction> = new Map([
  [MNY_ACTION.BUY_LEGACY, InvestmentAction.BUY],
  [MNY_ACTION.BUY, InvestmentAction.BUY],
  [MNY_ACTION.SELL, InvestmentAction.SELL],
  [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
  [MNY_ACTION.INTEREST, InvestmentAction.INTEREST],
  [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
  [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
  // Money's activity vocabulary now exists 1:1 in Monize (issue #1149), so
  // nothing is collapsed: the income kind -- interest versus short- versus
  // long-term capital gain, paid out versus reinvested -- survives the import
  // for tax reporting. Each of these behaves financially exactly as its base
  // action does (see `baseInvestmentAction`).
  [MNY_ACTION.REINVEST_INTEREST, InvestmentAction.REINVEST_INTEREST],
  // Value and quantity like a buy, cash like a reinvestment -- and REINVEST is
  // the only Monize action that is both, so the cost basis survives.
  [MNY_ACTION.CONTRIBUTION, InvestmentAction.REINVEST],
  [MNY_ACTION.REMOVE_SHARES, InvestmentAction.REMOVE_SHARES],
  [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
  [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
  [MNY_ACTION.REMOVE_SHARES_LEGACY, InvestmentAction.REMOVE_SHARES],
  [MNY_ACTION.ST_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_SHORT],
  [MNY_ACTION.LT_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_LONG],
  [
    MNY_ACTION.REINVEST_ST_CAPITAL_GAINS,
    InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  ],
  [
    MNY_ACTION.REINVEST_LT_CAPITAL_GAINS,
    InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  ],
  [MNY_ACTION.REDEEM_CD_BOND, InvestmentAction.REDEEM],
  [MNY_ACTION.TRANSFER_IN, InvestmentAction.TRANSFER_IN],
  [MNY_ACTION.TRANSFER_OUT, InvestmentAction.TRANSFER_OUT],
]);

/**
 * Codes whose meaning is inferred or reported rather than measured here. A
 * mapper must attach a warning to every transaction it maps through one of
 * these, so the verification report shows the user what was assumed.
 *
 * `CONTRIBUTION` is here because the file proves what it does -- to a
 * position, and to cash -- and issue #1149 supplies Money's name for it
 * ("Add Shares"), but Monize models it as REINVEST so the stated value
 * survives as cost basis; the warning keeps that translation reviewable.
 * The `act` 10 / 24 / 26 / 27 / 29 / 30 distribution family is the converse:
 * each is named by issue #1149's reporter against Money's own register and
 * corroborated by Money's QIF vocabulary, but no file available here carries
 * one, so their `TRN_INV` shape and lot behaviour are unmeasured. Both kinds
 * are mapped and reported, which is the rule -- codes 17, 18 and 20 turn up
 * in real files with no lot and no name to explain them, so they stay
 * unmapped and are skipped with a warning rather than guessed at. `act` 4
 * left this set when issue #1149 named it: its cash-only behaviour was
 * already measured, so nothing about it is assumed any more.
 */
export const MNY_UNCONFIRMED_ACTIONS: ReadonlySet<number> = new Set([
  MNY_ACTION.REINVEST_ALT,
  MNY_ACTION.CAPITAL_GAIN,
  MNY_ACTION.CONTRIBUTION,
  MNY_ACTION.REINVEST_INTEREST,
  MNY_ACTION.ST_CAPITAL_GAINS_DIST,
  MNY_ACTION.LT_CAPITAL_GAINS_DIST,
  MNY_ACTION.REINVEST_ST_CAPITAL_GAINS,
  MNY_ACTION.REINVEST_LT_CAPITAL_GAINS,
  MNY_ACTION.REDEEM_CD_BOND,
]);

/**
 * Codes that carry their amount on `TRN.amt` alone, with no `TRN_INV` row.
 * Iterating `TRN_INV` instead of `TRN` drops every one of them, which is
 * PR #192 issue 4.
 *
 * `act` 3 and 4 are measured: every such row in both Money Plus files is
 * absent from `TRN_INV`. The `act` 24 / 26 cash capital-gain distributions
 * are inferred to share the shape -- they are cash payouts exactly like 3 and
 * 4, and no available file carries one to measure. Membership here only
 * suppresses the missing-detail warning; a detail row, if a file does supply
 * one, is still read and used.
 */
const CASH_ONLY_ACTIONS: ReadonlySet<number> = new Set([
  MNY_ACTION.DIVIDEND,
  MNY_ACTION.INTEREST,
  MNY_ACTION.ST_CAPITAL_GAINS_DIST,
  MNY_ACTION.LT_CAPITAL_GAINS_DIST,
]);

/**
 * The Monize action for a Money `act` code, or null when the code is unknown.
 * Unknown codes are skipped and counted, never guessed.
 *
 * Direction always comes from the action -- `TRN_INV.qty` is stored positive,
 * so inferring buy-versus-sell from a quantity sign silently corrupts
 * positions.
 */
export function mapInvestmentAction(act: number): InvestmentAction | null {
  return ACTION_BY_CODE.get(act) ?? null;
}

/**
 * False for the actions that carry no `TRN_INV` row -- the cash distributions.
 * Both Money Plus files confirm the measured half: every `act` 3 and `act` 4
 * row is absent from `TRN_INV`, and every other action they contain has a row
 * there. The `act` 24 / 26 members are inferred from being the same kind of
 * cash payout; see `CASH_ONLY_ACTIONS`.
 */
export function hasInvestmentDetail(act: number): boolean {
  return !CASH_ONLY_ACTIONS.has(act);
}

// ---------------------------------------------------------------------------
// Securities (`SEC.sct`)
// ---------------------------------------------------------------------------

/**
 * True when a symbol has the shape Money uses for a currency quote --
 * `/GBPUS`, `/ARSUS`. Confirmed: every `CRNC.szSymbol` in every fixture
 * matches, and no `SEC` row in any of them has the shape.
 */
export function isCurrencyQuoteSymbol(symbol: string): boolean {
  return /^\/[A-Z]{3}[A-Z]{2}$/.test(symbol);
}

/**
 * True when a `SEC` row is a currency rather than a real security.
 *
 * The symbol shape is the whole test, and deliberately so. This used to also
 * exclude `sct` 4 on the theory that Money files currencies in `SEC` under a
 * type code -- **`sct` 4 is a money-market fund**. Money Plus's own
 * `sample.mny` files "Vanguard Money Market Fund", "Merrill Lynch Money
 * Market", "Smith Barney Money Market" and "Woodgrove Money Market" under it,
 * and all four of the maintainer's are money-market funds too (TD Canadian
 * Money Market, CIBC Canadian Money Market, CIBC Canadian T-Bill, McLean
 * Budden Money Market). Excluding the code dropped 829 of that file's 4,524
 * investment transactions -- every money-market trade in seven brokerage
 * accounts -- as `missingInvestmentDetail`, because the security they point at
 * was never imported.
 *
 * Currencies do not live in `SEC` in any file measured: all five carry their
 * `/GBPUS`-shaped symbols in `CRNC` alone. `sct` codes are also not stable
 * across releases (the same Amex indices are `sct` 6 in Money 2001/2002 and
 * `sct` 7 in Money Plus), which is why none of them is read for meaning --
 * see the note on `mapSecurities` about `securityType` staying null.
 */
export function isCurrencyPseudoSecurity(symbol: string): boolean {
  return isCurrencyQuoteSymbol(symbol);
}

// ---------------------------------------------------------------------------
// Categories (`CAT.lType`)
// ---------------------------------------------------------------------------

/**
 * `CAT.lType` values. Confirmed across all three fixture vintages: -1 marks
 * the two roots, {0, 1} sit under EXPENSE and {2, 3} under INCOME, with no
 * crossover in 349 categories.
 */
export const MNY_CATEGORY_TYPE = {
  /** The INCOME and EXPENSE roots themselves. */
  ROOT: -1,
  EXPENSE: 0,
  EXPENSE_ALT: 1,
  INCOME: 2,
  INCOME_ALT: 3,
} as const;

const INCOME_TYPES: ReadonlySet<number> = new Set([
  MNY_CATEGORY_TYPE.INCOME,
  MNY_CATEGORY_TYPE.INCOME_ALT,
]);
const EXPENSE_TYPES: ReadonlySet<number> = new Set([
  MNY_CATEGORY_TYPE.EXPENSE,
  MNY_CATEGORY_TYPE.EXPENSE_ALT,
]);

/**
 * Whether a category is income, from `lType` alone; null for the roots and for
 * codes outside the confirmed set, where the caller falls back to walking to
 * the root ancestor (`INCOME` `hcat` 130 versus `EXPENSE` 131 in every
 * fixture, though the handles are not guaranteed).
 */
export function isIncomeCategoryType(categoryType: number): boolean | null {
  if (INCOME_TYPES.has(categoryType)) {
    return true;
  }
  return EXPENSE_TYPES.has(categoryType) ? false : null;
}

// ---------------------------------------------------------------------------
// Frequencies (`BILL.frq` + `BILL.cFrqInst`)
// ---------------------------------------------------------------------------

/**
 * `BILL.frq` -- the **unit** a Money recurrence is counted in, not the
 * recurrence itself. The recurrence is the pair `(frq, cFrqInst)`.
 *
 * `cFrqInst` is how many times the bill falls due **per unit**, so the cycle is
 * `unit / cFrqInst`. It is a rate, not an interval multiplier, and reading it
 * as the latter inverts every non-unit cadence in the file: `frq` 3 with
 * `cFrqInst` 2 is twice a *month* (a semi-monthly payroll), and the old table
 * imported it as every two months -- while `frq` 3 with `cFrqInst` 0.5, the
 * real every-other-month, rounded to 1 and imported as monthly. The values are
 * fractional (0.5, 0.25) precisely because they are a rate; an interval
 * multiplier has no reason to be.
 *
 * Every code and every rate below is read off `klasko.mny`, a Money Plus Sunset
 * file in which the frequency of each series was written into the payee memo
 * and matched against the stored pair, and cross-checked against the spacing of
 * the series' own instance dates (a `frq` 4 series is 3 months apart, `frq` 2
 * with 0.5 is 14 days apart, and so on). That replaces the guessed table issue
 * #1150 was about -- PR #192's list claimed 4 = yearly, and 4 is quarterly.
 *
 * Money's picker offers thirteen cadences and all thirteen are `(unit, rate)`
 * pairs over these five units; `MONEY_CADENCES` in the spec enumerates them.
 */
export const MNY_FREQUENCY = {
  ONCE: 0,
  DAILY: 1,
  WEEKLY: 2,
  MONTHLY: 3,
  QUARTERLY: 4,
  YEARLY: 5,
} as const;

/**
 * Mean length of one `frq` unit, in days.
 *
 * Spelled as fractions of `365.25` so that `unit / cFrqInst` lands exactly on a
 * `FREQUENCY_CYCLE_DAYS` entry for each of Money's thirteen cadences -- which
 * is what lets the match below be an equality rather than a tolerance, and what
 * makes an unrepresentable cadence detectable instead of merely near-miss.
 */
const UNIT_DAYS: Record<number, number> = {
  [MNY_FREQUENCY.DAILY]: 1,
  [MNY_FREQUENCY.WEEKLY]: 7,
  [MNY_FREQUENCY.MONTHLY]: 365.25 / 12,
  [MNY_FREQUENCY.QUARTERLY]: 365.25 / 4,
  [MNY_FREQUENCY.YEARLY]: 365.25,
};

export interface MnyFrequencyMapping {
  readonly frequency: FrequencyType;
  /**
   * True when Monize has no type for the cadence Money recorded, so the mapping
   * changes how often the bill falls due and the mapper must warn per bill.
   * Every cadence Money's own picker offers maps exactly -- `EVERY4MONTHS` and
   * `EVERY2YEARS` were added for the last two of them -- so this is reserved
   * for a `(frq, cFrqInst)` pair the picker cannot produce, such as every three
   * weeks or every five months.
   */
  readonly approximate: boolean;
}

/** How close two cycle lengths must be to count as the same cadence. */
const CYCLE_EPSILON = 1e-9;

/** The frequency whose cycle is exactly `days`, or null. */
function frequencyForCycleDays(days: number): FrequencyType | null {
  for (const [frequency, cycle] of Object.entries(FREQUENCY_CYCLE_DAYS)) {
    if (cycle > 0 && Math.abs(cycle - days) <= CYCLE_EPSILON * cycle) {
      return frequency as FrequencyType;
    }
  }
  return null;
}

/**
 * The longest frequency whose cycle does not exceed `days`.
 *
 * Rounding *down* is the safe direction: v1 imports bills with
 * `auto_post = false`, so an extra reminder is noise while a missed one is a
 * missed payment. Nothing is shorter than `DAILY`, so a sub-daily cadence lands
 * there.
 */
function nearestShorterFrequency(days: number): FrequencyType {
  return Object.entries(FREQUENCY_CYCLE_DAYS)
    .filter(([, cycle]) => cycle > 0 && cycle <= days)
    .reduce<[FrequencyType, number]>(
      (best, entry) =>
        entry[1] > best[1] ? [entry[0] as FrequencyType, entry[1]] : best,
      [FrequencyType.DAILY, 0],
    )[0];
}

/**
 * Maps a Money recurrence onto a Monize frequency.
 *
 * Returns null for an unknown `frq`, which the mapper reports (`unusableBill`,
 * with the raw pair) rather than guesses. The bill mapper asks the series' own
 * instance dates before it asks this function, so an unmapped code only loses a
 * series that has no spacing to read.
 *
 * @param frequency `BILL.frq` -- the unit, see `MNY_FREQUENCY`
 * @param occurrencesPerUnit `BILL.cFrqInst` -- occurrences per unit, so 2 on a
 *   monthly unit is twice a month and 0.5 is every other month
 */
export function mapFrequency(
  frequency: number,
  occurrencesPerUnit = 1,
): MnyFrequencyMapping | null {
  if (frequency === MNY_FREQUENCY.ONCE) {
    // A one-off recurs no times; whatever rate sits beside it says nothing.
    return { frequency: FrequencyType.ONCE, approximate: false };
  }

  const unit = UNIT_DAYS[frequency];
  if (unit === undefined) {
    return null;
  }

  const rate =
    Number.isFinite(occurrencesPerUnit) && occurrencesPerUnit > 0
      ? occurrencesPerUnit
      : 1;
  const cycleDays = unit / rate;

  const exact = frequencyForCycleDays(cycleDays);
  return exact !== null
    ? { frequency: exact, approximate: false }
    : { frequency: nearestShorterFrequency(cycleDays), approximate: true };
}

// ---------------------------------------------------------------------------
// Bills (`BILL.st`)
// ---------------------------------------------------------------------------

/*
 * No `BILL.st` constants are exported, on purpose.
 *
 * Which rows belong to a live series is still open (design question 3):
 * `BILL` is empty in every committed fixture, so no value of `st` has ever
 * been observed. The table carries both `hbillHead` (series) and `iinst`
 * (instance), which suggests rows are instances of a series rather than series
 * themselves, but that is inference, not evidence. Task M3.1 must derive the
 * active set from a real file and validate it against the known "about 20 real
 * bills out of 1,844 rows" ground truth; the wizard's checkbox list is the
 * safety net either way. A plausible-looking constant here would only make the
 * guess harder to see.
 */
