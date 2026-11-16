import { BondRedemptionSplitPreview } from "../ai/actions/ai-action.types";
import { roundToDecimals } from "../common/round.util";
import { INVESTMENT_PRICE_DECIMALS } from "./investment-amount.util";

/**
 * A difference below this is rounding (a price at two decimals times a whole
 * number of bonds), not a different split: one cent of the security's currency.
 */
const SPLIT_TOLERANCE = 0.01;

/** The engine's split of one redemption, as numbers (a refused split never gets here). */
export interface RedemptionSplitFigures {
  readonly principal: number;
  readonly deduction: number;
  readonly interest: number;
  readonly principalReturned: number;
  readonly payout: number;
}

/** What the caller of a preview supplied for the redemption row. */
export interface SuppliedRedemption {
  /** A whole number of bonds, greater than zero. */
  readonly quantity: number;
  readonly price: number | null;
  /** The executed total, when the caller gave one instead of a price. */
  readonly totalAmount: number | undefined;
  readonly commission: number;
  readonly accruedInterest: number;
}

/** The row's price, total and interest after the split was applied, and what the card shows. */
export interface FilledRedemption {
  readonly price: number | null;
  readonly totalAmount: number | undefined;
  readonly accruedInterest: number;
  readonly split: BondRedemptionSplitPreview;
}

/**
 * Apply a bond redemption's split to what a caller supplied
 * (`docs/specs/bond-redemption-interest.md` 2.1; INV-BOND-009). The server
 * fills what the caller left out, never overrides what it stated:
 *
 * - no accrued interest (none, or 0) and no price or total: both are filled,
 *   price = principal returned / quantity, accrued interest = interest;
 * - no accrued interest and a price (or total) that is the whole payout per
 *   bond, the amount a person reads off the broker's confirmation: the same
 *   fill, so the interest is not booked as a capital gain;
 * - accrued interest given and no price: the price is filled;
 * - anything else is kept as given, and the outcome says `differs` when it
 *   departs from the split by more than rounding, so the card warns.
 */
export function applyRedemptionSplit(
  split: RedemptionSplitFigures,
  supplied: SuppliedRedemption,
): FilledRedemption {
  const { quantity, commission } = supplied;
  const splitPrice = roundToDecimals(
    split.principalReturned / quantity,
    INVESTMENT_PRICE_DECIMALS,
  );
  const splitInterest = roundToDecimals(split.interest, 4);

  let price = supplied.price;
  let totalAmount = supplied.totalAmount;
  let interest = supplied.accruedInterest;
  let filled = false;

  if (!(interest > 0)) {
    const gross =
      price !== null
        ? price * quantity
        : totalAmount !== undefined
          ? totalAmount + commission
          : null;
    if (gross === null || Math.abs(gross - split.payout) <= SPLIT_TOLERANCE) {
      price = splitPrice;
      totalAmount = undefined;
      interest = splitInterest;
      filled = true;
    }
  } else if (price === null && totalAmount === undefined) {
    price = splitPrice;
    filled = true;
  }

  const gross =
    price !== null
      ? price * quantity
      : totalAmount !== undefined
        ? totalAmount + commission
        : 0;
  const differs =
    Math.abs(gross - split.principalReturned) > SPLIT_TOLERANCE ||
    Math.abs(interest - split.interest) > SPLIT_TOLERANCE;

  return {
    price,
    totalAmount,
    accruedInterest: interest,
    split: {
      principal: split.principal,
      interest: split.interest,
      deduction: split.deduction,
      payout: split.payout,
      outcome: differs ? "differs" : filled ? "filled" : "matches",
    },
  };
}
