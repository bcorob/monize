import { InvestmentAction, InvestmentTransaction } from '@/types/investment';
import { TransactionStatus } from '@/types/transaction';
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
 * Whether a row moved anything. A VOID row is listed as a record but moved no
 * money and no shares, so it joins no total. Mirrors the backend's
 * `investmentRowHasEffect` (`securities/investment-row-effects.util.ts`).
 */
export function investmentRowHasEffect(tx: Pick<InvestmentTransaction, 'status'>): boolean {
  return tx.status !== TransactionStatus.VOID;
}

/** Distributions paid in cash. Mirrors the backend's `CASH_INCOME_ACTIONS`. */
export const CASH_INCOME_ACTIONS: readonly InvestmentAction[] = [
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
  'CAPITAL_GAIN_SHORT',
  'CAPITAL_GAIN_LONG',
];

/**
 * The income each reinvestment records: a distribution paid in shares is income
 * of the same kind as its cash twin. Mirrors the backend's `incomeKind`
 * (`securities/investment-replay.util.ts`).
 */
const INCOME_KIND_BY_REINVEST_ACTION: Partial<Record<InvestmentAction, InvestmentAction>> = {
  REINVEST: 'DIVIDEND',
  REINVEST_INTEREST: 'INTEREST',
  REINVEST_CAPITAL_GAIN_SHORT: 'CAPITAL_GAIN_SHORT',
  REINVEST_CAPITAL_GAIN_LONG: 'CAPITAL_GAIN_LONG',
};

/** Distributions paid in shares. */
export const REINVESTED_INCOME_ACTIONS = Object.keys(
  INCOME_KIND_BY_REINVEST_ACTION,
) as InvestmentAction[];

/** Every action that records investment income, in cash or in shares. */
export const INCOME_ACTIONS: readonly InvestmentAction[] = [
  ...CASH_INCOME_ACTIONS,
  ...REINVESTED_INCOME_ACTIONS,
];

/**
 * The kind of income an action records, as the cash-income action it equals,
 * or null for one that records none. `baseInvestmentAction` of the answer is
 * DIVIDEND, INTEREST or CAPITAL_GAIN.
 */
export function incomeKind(action: InvestmentAction): InvestmentAction | null {
  if (CASH_INCOME_ACTIONS.includes(action)) return action;
  return INCOME_KIND_BY_REINVEST_ACTION[action] ?? null;
}

/**
 * The income bucket an action falls in -- DIVIDEND, INTEREST or CAPITAL_GAIN,
 * whether paid in cash or reinvested -- or null for one that records none.
 */
export function incomeBaseKind(action: InvestmentAction): InvestmentAction | null {
  const kind = incomeKind(action);
  return kind === null ? null : baseInvestmentAction(kind);
}

/**
 * The income one row records, in the security's currency, unsigned. A cash
 * distribution is its total. A reinvested one is its stored total when it has
 * one (an imported row keeps the file's amount), else quantity x price +
 * commission, because a reinvest created in the app stores no total. A legacy
 * reinvest with neither a total nor a price is left out, as the cost basis
 * leaves it out. Mirrors the backend's `investmentIncomeAmount`.
 */
export function investmentIncomeAmount(
  tx: Pick<InvestmentTransaction, 'action' | 'quantity' | 'price' | 'commission' | 'totalAmount'>,
): number {
  if (CASH_INCOME_ACTIONS.includes(tx.action)) return Math.abs(Number(tx.totalAmount) || 0);
  if (!INCOME_KIND_BY_REINVEST_ACTION[tx.action]) return 0;
  const total = Number(tx.totalAmount);
  if (Number.isFinite(total) && total !== 0) return Math.abs(total);
  const price = Number(tx.price);
  if (tx.price === null || !Number.isFinite(price) || price <= 0) return 0;
  const quantity = Number(tx.quantity) || 0;
  const commission = Number(tx.commission) || 0;
  return roundToDecimals(quantity * price + commission, 4);
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
