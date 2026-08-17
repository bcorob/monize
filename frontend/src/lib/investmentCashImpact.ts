import { InvestmentAction } from '@/types/investment';
import { baseInvestmentAction } from '@/lib/investment-actions';

export const EMBEDDED_INVESTMENT_SPLIT_ACTIONS: ReadonlyArray<InvestmentAction> = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
  'REINVEST',
  // Money-vocabulary refinements: allowed wherever their base is.
  'REDEEM',
  'CAPITAL_GAIN_SHORT',
  'CAPITAL_GAIN_LONG',
  'REINVEST_INTEREST',
  'REINVEST_CAPITAL_GAIN_SHORT',
  'REINVEST_CAPITAL_GAIN_LONG',
];

export function isInvestmentActionAllowedInSplit(action: InvestmentAction): boolean {
  return EMBEDDED_INVESTMENT_SPLIT_ACTIONS.includes(action);
}

/**
 * Mirrors backend `computeInvestmentCashImpact` so the split editor can
 * derive the cash side of an investment split as the user types.
 */
export function computeInvestmentCashImpact(
  action: InvestmentAction,
  quantity: number,
  price: number,
  commission: number,
): number {
  const q = Number(quantity) || 0;
  const p = Number(price) || 0;
  const c = Number(commission) || 0;
  switch (baseInvestmentAction(action)) {
    case 'BUY':
      return -(q * p + c);
    case 'SELL':
      return q * p - c;
    case 'DIVIDEND':
    case 'INTEREST':
    case 'CAPITAL_GAIN':
      return (q || 1) * p;
    case 'REINVEST':
      return 0;
    default:
      return 0;
  }
}
