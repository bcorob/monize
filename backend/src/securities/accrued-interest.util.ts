import { roundMoney } from "../common/round.util";
import { InvestmentAction } from "./entities/investment-transaction.entity";

/**
 * The actions that may carry accrued interest.
 *
 * REDEEM only. A bond sold between coupon dates accrues interest too, but
 * Microsoft Money emits it only on `act` 30 (Redeem CD/Bond), so a SELL field
 * would be a manual-entry-only path with no import evidence behind it. See
 * `docs/specs/redemption-accrued-interest.md` section 1.2.
 */
export const ACCRUED_INTEREST_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.REDEEM,
]);

export function supportsAccruedInterest(action: InvestmentAction): boolean {
  return ACCRUED_INTEREST_ACTIONS.has(action);
}

/**
 * The magnitude, in the security's currency, of the cash a disposal moves.
 *
 * Before accrued interest existed, a linked cash row was always
 * `|totalAmount| x exchangeRate`, and several call sites were written against
 * that equality. A redemption breaks it: the row's `totalAmount` is proceeds
 * (`quantity x price - commission`), which is what every realized-gain fold
 * measures against cost basis, while the cash that actually arrives is the
 * proceeds plus the accrued interest the issuer paid out with them.
 *
 * Folding the interest into `totalAmount` instead would report it as capital
 * gain on the tax surfaces, so the two are added here and nowhere else.
 * `accrued-interest.guard.spec.ts` fails a second addition.
 */
export function disposalCashAmount(
  totalAmount: number | string,
  accruedInterest: number | string | null | undefined,
): number {
  return roundMoney(Number(totalAmount) + Number(accruedInterest ?? 0));
}

/**
 * The inverse: proceeds recovered from a gross cash figure that already
 * includes accrued interest. Microsoft Money's `TRN.amt` on an `act` 30 row is
 * such a figure, and the redemption's `totalAmount` must exclude the interest
 * for the same reason `disposalCashAmount` exists.
 */
export function proceedsExcludingAccruedInterest(
  grossCashAmount: number | string,
  accruedInterest: number | string | null | undefined,
): number {
  return roundMoney(Number(grossCashAmount) - Number(accruedInterest ?? 0));
}

/** The two fields that decide whether a linked pair is a redemption + interest. */
interface LinkedRow {
  action: InvestmentAction;
  linkedTransactionId?: string | null;
  id?: string;
}

/**
 * Whether `row` is the accrued-interest companion of `partner`.
 *
 * `linked_transaction_id` links TRANSFER_IN/TRANSFER_OUT legs as well, and the
 * transfer edit path assumes any linked pair is a transfer -- so the two uses
 * are told apart by action rather than by a flag. A linked INTEREST row whose
 * partner is a REDEEM is a companion; a free-standing INTEREST row (no link) is
 * an ordinary interest payment and is edited and reported as one.
 */
export function isAccruedInterestCompanion(
  row: LinkedRow,
  partner: LinkedRow,
): boolean {
  return (
    row.action === InvestmentAction.INTEREST &&
    supportsAccruedInterest(partner.action) &&
    row.linkedTransactionId != null &&
    (partner.id === undefined || row.linkedTransactionId === partner.id)
  );
}
