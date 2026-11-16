import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  MONEY99_ACTION_BY_CODE,
  MONEY99_CASH_ONLY_ACTIONS,
  MnyFileFormat,
} from "./mny-money99";

/**
 * Money's investment action codes (`TRN.act`) and the Monize action each maps
 * to. Split out of `mny-model.ts` when Money 97-99 support made the lookups
 * format-dependent; the format's own tables are in `mny-money99.ts`.
 */

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
 * Unknown codes are skipped and counted, never guessed. The table depends on
 * the file's format: Money 97-99 number their actions differently, and their
 * SELL (1) is Money Plus's BUY.
 *
 * Direction always comes from the action -- `TRN_INV.qty` is stored positive,
 * so inferring buy-versus-sell from a quantity sign silently corrupts
 * positions.
 */
export function mapInvestmentAction(
  act: number,
  format: MnyFileFormat,
): InvestmentAction | null {
  const table = format === "jet3" ? MONEY99_ACTION_BY_CODE : ACTION_BY_CODE;
  return table.get(act) ?? null;
}

/**
 * True when `act` is mapped through a meaning that is inferred rather than
 * measured (`MNY_UNCONFIRMED_ACTIONS`). Every Money 97-99 code that maps at all
 * was measured, so none of them is.
 */
export function isUnconfirmedInvestmentAction(
  act: number,
  format: MnyFileFormat,
): boolean {
  return format === "msisam" && MNY_UNCONFIRMED_ACTIONS.has(act);
}

/**
 * False for the actions that carry no `TRN_INV` row -- the cash distributions.
 * Both Money Plus files confirm the measured half: every `act` 3 and `act` 4
 * row is absent from `TRN_INV`, and every other action they contain has a row
 * there. The `act` 24 / 26 members are inferred from being the same kind of
 * cash payout; see `CASH_ONLY_ACTIONS`.
 */
export function hasInvestmentDetail(
  act: number,
  format: MnyFileFormat,
): boolean {
  const cashOnly =
    format === "jet3" ? MONEY99_CASH_ONLY_ACTIONS : CASH_ONLY_ACTIONS;
  return !cashOnly.has(act);
}
