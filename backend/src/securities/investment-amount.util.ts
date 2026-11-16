import { roundMoney, roundToDecimals } from "../common/round.util";
import { InvestmentAction } from "./entities/investment-transaction.entity";
import { baseInvestmentAction } from "./investment-replay.util";

/**
 * The scale of `investment_transactions.price` -- `NUMERIC(24,10)`, wider than
 * money on purpose (`docs/financial-semantics.md` section 4).
 */
export const INVESTMENT_PRICE_DECIMALS = 10;

/** The fields every total/price derivation reads off a row or a DTO. */
export interface InvestmentAmountInput {
  action: InvestmentAction | string;
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
}

/** What a caller supplied, with the executed total when it knows one. */
export interface SuppliedInvestmentAmounts extends InvestmentAmountInput {
  /**
   * The executed total in the security's currency, net of nothing but what
   * `deriveInvestmentTotal` puts in it: commission added on an acquisition,
   * subtracted on a disposal, accrued interest excluded.
   */
  totalAmount?: number | string | null;
}

/** The pair a write stores: the total as the fact, the price beside it. */
export interface ResolvedInvestmentAmounts {
  totalAmount: number;
  price: number | null;
}

function num(value: number | string | null | undefined): number {
  return Number(value) || 0;
}

/**
 * The total a quantity and a per-share price imply, at money precision.
 *
 * `total_amount` is `quantity * price + commission` for an acquisition and
 * `quantity * price - commission` for a disposal, so a sell's commission
 * reduces proceeds. The share-only actions and everything with no cash side
 * carry no total at all.
 */
export function deriveInvestmentTotal(input: InvestmentAmountInput): number {
  const quantity = num(input.quantity);
  const price = num(input.price);
  const commission = num(input.commission);

  switch (baseInvestmentAction(input.action)) {
    case InvestmentAction.BUY:
      return roundMoney(quantity * price + commission);
    case InvestmentAction.SELL:
      return roundMoney(quantity * price - commission);
    case InvestmentAction.DIVIDEND:
    case InvestmentAction.INTEREST:
    case InvestmentAction.CAPITAL_GAIN:
    case InvestmentAction.RETURN_OF_CAPITAL:
      return roundMoney((quantity || 1) * price);
    default:
      // ADD_SHARES / REMOVE_SHARES / SPLIT / REINVEST / the transfer legs move
      // shares without a cash total of their own.
      return 0;
  }
}

/**
 * Whether an action's total is a figure at all, rather than the constant zero
 * `deriveInvestmentTotal` returns for the share-only and no-cash actions. A
 * supplied total is only honoured for these.
 */
export function actionCarriesTotal(action: InvestmentAction | string): boolean {
  switch (baseInvestmentAction(action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.SELL:
    case InvestmentAction.DIVIDEND:
    case InvestmentAction.INTEREST:
    case InvestmentAction.CAPITAL_GAIN:
    case InvestmentAction.RETURN_OF_CAPITAL:
      return true;
    default:
      return false;
  }
}

/**
 * The per-share price an executed total implies, at the price column's own
 * scale.
 *
 * The inverse of `deriveInvestmentTotal`: the commission comes back out of an
 * acquisition's total and back into a disposal's before the division, because
 * the price is what the shares changed hands at, not what the trade cost.
 *
 * `null` when the row cannot say: no shares to divide by, or an action that
 * carries no total. The caller keeps whatever price it already had.
 */
export function derivePriceFromTotal(input: {
  action: InvestmentAction | string;
  totalAmount: number;
  quantity?: number | string | null;
  commission?: number | string | null;
}): number | null {
  const quantity = num(input.quantity);
  const commission = num(input.commission);
  const total = Number(input.totalAmount);
  if (!Number.isFinite(total)) return null;

  switch (baseInvestmentAction(input.action)) {
    case InvestmentAction.BUY:
      if (quantity <= 0) return null;
      return roundToDecimals(
        (total - commission) / quantity,
        INVESTMENT_PRICE_DECIMALS,
      );
    case InvestmentAction.SELL:
      if (quantity <= 0) return null;
      return roundToDecimals(
        (total + commission) / quantity,
        INVESTMENT_PRICE_DECIMALS,
      );
    case InvestmentAction.DIVIDEND:
    case InvestmentAction.INTEREST:
    case InvestmentAction.CAPITAL_GAIN:
    case InvestmentAction.RETURN_OF_CAPITAL:
      return roundToDecimals(
        total / (quantity || 1),
        INVESTMENT_PRICE_DECIMALS,
      );
    default:
      return null;
  }
}

/**
 * The total and the price a write stores, from whatever the caller supplied.
 *
 * **The executed total is the fact; the per-share price is derived from it.**
 * A statement says a sale of 141 shares realised 820.9081; dividing that by
 * 141 gives 5.8220... and storing a price rounded to the cent turns the trade
 * back into 141 x 5.82 = 820.62. So when a caller supplies a total it is
 * stored as given, at money precision, and the price follows it at the price
 * column's ten decimals. When a caller supplies only a price -- an import
 * whose source carries no amount, the assistant, a scheduled posting -- the
 * total is derived from the price, as it always was.
 *
 * A supplied price is kept untouched when it already implies the supplied
 * total, so a caller that sends both consistent figures loses nothing to the
 * division.
 */
export function resolveInvestmentAmounts(
  input: SuppliedInvestmentAmounts,
): ResolvedInvestmentAmounts {
  const price =
    input.price === null || input.price === undefined
      ? null
      : Number(input.price);
  const supplied =
    input.totalAmount === null || input.totalAmount === undefined
      ? null
      : Number(input.totalAmount);

  if (supplied === null || !Number.isFinite(supplied)) {
    return { totalAmount: deriveInvestmentTotal(input), price };
  }
  if (!actionCarriesTotal(input.action)) {
    return { totalAmount: 0, price };
  }

  const totalAmount = roundMoney(supplied);
  if (
    price !== null &&
    deriveInvestmentTotal({ ...input, price }) === totalAmount
  ) {
    return { totalAmount, price };
  }
  const derived = derivePriceFromTotal({
    action: input.action,
    totalAmount,
    quantity: input.quantity,
    commission: input.commission,
  });
  return { totalAmount, price: derived ?? price };
}
