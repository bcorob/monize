import { InvestmentAction } from "./entities/investment-transaction.entity";
import { baseInvestmentAction } from "./investment-replay.util";

/**
 * The one place a cash leg's payee label is built from an investment action.
 *
 * A trade's cash movement lands in the cash sleeve as a plain transaction, and
 * the register's Payee column is the only thing on that row that can say why
 * the money moved -- Money itself labels the line with the activity. Three
 * producers create those rows (native create, QIF import, .mny import) and the
 * label was written out twice and omitted once: the QIF copy hard-coded a `$`
 * over an amount it had just carefully converted, and the .mny writer wrote no
 * label at all, so every imported trade's cash leg rendered as "-" (issue
 * #1204). Same family as `applyActionToQuantity`: one fold, one implementation.
 *
 * `investment-cash-payee.guard.spec.ts` fails when a fourth copy appears.
 */
export interface InvestmentCashPayeeInput {
  /** The raw action, not its base: a redemption reads "Redeem", not "Sell". */
  readonly action: InvestmentAction;
  readonly symbol: string | null;
  readonly quantity: number | null;
  readonly price: number | null;
  /**
   * The size of the activity. Signed input is fine -- the label describes what
   * happened and the register's amount column carries the direction, so a Buy
   * must not read "Buy: VOO $-1,500.00".
   */
  readonly totalAmount: number;
  /**
   * The currency the price and total are denominated in. A blank or malformed
   * code renders the figures without a symbol rather than throwing: `.mny`
   * accounts can carry an empty code, and `Intl` raises `RangeError` on one,
   * which would abort a whole import over a label.
   */
  readonly currencyCode?: string | null;
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function formatAmount(value: number, currencyCode: string | null): string {
  const options: Intl.NumberFormatOptions =
    currencyCode && CURRENCY_CODE.test(currencyCode)
      ? {
          style: "currency",
          currency: currencyCode.toUpperCase(),
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        }
      : { minimumFractionDigits: 2, maximumFractionDigits: 4 };
  return value.toLocaleString("en-US", options);
}

/** Trailing zeros dropped, but never more than the 4dp the column stores. */
function formatQuantity(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/** `CAPITAL_GAIN` -> `Capital Gain`. Exported for warning copy that has to
 * name the activity outside a payee label. */
export function formatInvestmentActionLabel(action: string): string {
  return action
    .split("_")
    .map((word) =>
      word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word,
    )
    .join(" ");
}

export function formatInvestmentCashPayeeName(
  input: InvestmentCashPayeeInput,
): string {
  const currencyCode = input.currencyCode ?? null;
  const total = Math.abs(input.totalAmount);
  const actionLabel = formatInvestmentActionLabel(input.action);

  // The label keeps the raw action's name; only the shape of the line follows
  // the base action, so REDEEM reads like a SELL without being called one.
  switch (baseInvestmentAction(input.action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.SELL:
      return `${actionLabel}: ${input.symbol || "Unknown"} ${formatQuantity(
        input.quantity || 0,
      )} @ ${formatAmount(Math.abs(input.price || 0), currencyCode)}`;

    case InvestmentAction.DIVIDEND:
    case InvestmentAction.CAPITAL_GAIN:
      return `${actionLabel}: ${input.symbol || "Unknown"} ${formatAmount(
        total,
        currencyCode,
      )}`;

    case InvestmentAction.INTEREST:
      return `${actionLabel}: ${formatAmount(total, currencyCode)}`;

    default: {
      // No `${symbol || ""} ` interpolation: an action with no security left a
      // double space in the middle of the label.
      const parts = [input.symbol, formatAmount(total, currencyCode)].filter(
        (part): part is string => Boolean(part),
      );
      return `${actionLabel}: ${parts.join(" ")}`;
    }
  }
}
