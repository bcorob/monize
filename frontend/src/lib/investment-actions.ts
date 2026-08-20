import { InvestmentAction } from '@/types/investment';
import { roundToDecimals } from '@/lib/format';

/**
 * The base action each Money-vocabulary refinement behaves as. Mirrors the
 * backend's `baseInvestmentAction` (`securities/investment-replay.util.ts`):
 * a refinement moves shares and cash exactly like its base and differs only
 * in the kind of income it records, so every place the UI decides behaviour
 * (which fields show, how cash is derived, which sign a total takes)
 * normalizes first, and only labels read the raw action.
 */
const BASE_ACTION_BY_REFINEMENT: Partial<Record<InvestmentAction, InvestmentAction>> = {
  REINVEST_INTEREST: 'REINVEST',
  REINVEST_CAPITAL_GAIN_SHORT: 'REINVEST',
  REINVEST_CAPITAL_GAIN_LONG: 'REINVEST',
  CAPITAL_GAIN_SHORT: 'CAPITAL_GAIN',
  CAPITAL_GAIN_LONG: 'CAPITAL_GAIN',
  REDEEM: 'SELL',
};

export function baseInvestmentAction(action: InvestmentAction): InvestmentAction {
  return BASE_ACTION_BY_REFINEMENT[action] ?? action;
}

/**
 * Whether an action may carry accrued interest. REDEEM only -- and deliberately
 * not keyed on the base action, which is SELL and would let every sale offer it.
 * Mirrors `ACCRUED_INTEREST_ACTIONS` (backend `securities/accrued-interest.util.ts`).
 */
export function supportsAccruedInterest(action: InvestmentAction | string): boolean {
  return action === 'REDEEM';
}

/**
 * What the cash account receives: a redemption's proceeds plus the accrued
 * interest paid out with them. The interest is stored on a linked INTEREST
 * transaction, so the two are added for display in exactly one place -- the
 * mirror of the backend's `disposalCashAmount`.
 */
export function redemptionTotalWithInterest(
  totalAmount: number,
  accruedInterest: number | null | undefined,
): number {
  return roundToDecimals(Number(totalAmount) + Number(accruedInterest ?? 0), 4);
}
