import { InvestmentAction } from '@/types/investment';

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
