import { InvestmentAction } from "./entities/investment-transaction.entity";
import { baseInvestmentAction } from "./investment-replay.util";
import { disposalCashAmount } from "./accrued-interest.util";
import { roundMoney } from "../common/round.util";

export const EMBEDDED_INVESTMENT_SPLIT_ACTIONS: ReadonlySet<InvestmentAction> =
  new Set([
    InvestmentAction.BUY,
    InvestmentAction.SELL,
    InvestmentAction.DIVIDEND,
    InvestmentAction.INTEREST,
    InvestmentAction.CAPITAL_GAIN,
    InvestmentAction.REINVEST,
    // Money-vocabulary refinements: allowed wherever their base is.
    InvestmentAction.REDEEM,
    InvestmentAction.CAPITAL_GAIN_SHORT,
    InvestmentAction.CAPITAL_GAIN_LONG,
    InvestmentAction.REINVEST_INTEREST,
    InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
    InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  ]);

export function isInvestmentActionAllowedInSplit(
  action: InvestmentAction,
): boolean {
  return EMBEDDED_INVESTMENT_SPLIT_ACTIONS.has(action);
}

/**
 * Signed cash impact of an investment action in the security's currency,
 * before any FX conversion. Used by transaction-split validation to ensure the
 * embedded investment split's amount matches the implied cash side.
 *
 * Negative = cash leaves the brokerage cash account (BUY).
 * Positive = cash arrives in the brokerage cash account (SELL, DIVIDEND, etc).
 * Zero     = no cash side (REINVEST and the share-only actions).
 */
export function computeInvestmentCashImpact(
  action: InvestmentAction,
  quantity: number,
  price: number,
  commission: number,
  /** Accrued interest paid out with a redemption; see `disposalCashAmount`. */
  accruedInterest: number = 0,
): number {
  const q = Number(quantity) || 0;
  const p = Number(price) || 0;
  const c = Number(commission) || 0;

  switch (baseInvestmentAction(action)) {
    case InvestmentAction.BUY:
      return -(q * p + c);
    case InvestmentAction.SELL:
      return disposalCashAmount(q * p - c, accruedInterest);
    case InvestmentAction.DIVIDEND:
    case InvestmentAction.INTEREST:
    case InvestmentAction.CAPITAL_GAIN:
      return (q || 1) * p;
    case InvestmentAction.REINVEST:
      return 0;
    default:
      return 0;
  }
}

/**
 * The signed cash amount an embedded investment split moves, in the settlement
 * account's currency: the signed cash impact (security currency) converted at
 * `rate` and rounded to money precision. This is the single definition of that
 * figure -- `createEmbeddedForSplit`'s consistency check and the scheduled
 * posting/forecast paths (issue #1167) all derive the split's cash amount from
 * it, so a re-resolved FX rate produces one recomputed amount everywhere rather
 * than a stored figure that disagrees with a fresh rate.
 */
export function investmentSplitCashAmount(
  action: InvestmentAction,
  quantity: number,
  price: number,
  commission: number,
  rate: number,
): number {
  return roundMoney(
    computeInvestmentCashImpact(action, quantity, price, commission) * rate,
  );
}
