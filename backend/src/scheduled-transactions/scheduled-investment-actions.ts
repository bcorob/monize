import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

/**
 * Which investment fields a scheduled investment action requires, as data.
 *
 * These sets are read by both the schedule write path
 * (`ScheduledTransactionsService.validateInvestmentFields` / `postInvestment`)
 * and the effective-amount resolver (`ScheduledEffectiveAmountService`), which
 * derives what an occurrence would post today from the same fields. They live in
 * their own file so neither imports the other for them.
 *
 * Each Money-vocabulary refinement (REDEEM, CAPITAL_GAIN_SHORT/LONG,
 * REINVEST_*) validates exactly as its base action does.
 */
export const SECURITY_REQUIRED_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REDEEM,
  InvestmentAction.DIVIDEND,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.CAPITAL_GAIN_SHORT,
  InvestmentAction.CAPITAL_GAIN_LONG,
  InvestmentAction.SPLIT,
  InvestmentAction.REINVEST,
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
]);

export const QUANTITY_PRICE_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REDEEM,
  InvestmentAction.REINVEST,
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
]);

export const QUANTITY_ONLY_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.SPLIT,
]);

export const AMOUNT_ONLY_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.CAPITAL_GAIN_SHORT,
  InvestmentAction.CAPITAL_GAIN_LONG,
]);
