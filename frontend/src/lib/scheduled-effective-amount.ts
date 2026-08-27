import type {
  ScheduledTransaction,
  ScheduledTransactionOverride,
} from '@/types/scheduled-transaction';
import { sumConverted, type ConvertedTotal } from '@/lib/currency-total';

/**
 * The cash amount one scheduled occurrence would post today, and whether that is
 * known.
 *
 * `amount` is `null` exactly when the server could not determine it -- today,
 * when the current settlement exchange rate for an FX-sensitive schedule cannot
 * be resolved. `null` is never a licence to read the persisted
 * `ScheduledTransaction.amount`: that scalar was computed at whatever rate was
 * current when it was written, and presenting it as the current amount is the
 * defect this module exists to prevent (issue #1247).
 */
export interface EffectiveScheduledAmount {
  amount: number | null;
  currencyCode: string;
  /** `amount !== null`. A total containing an incomplete item is incomplete. */
  complete: boolean;
  /**
   * The signed amount that decides direction, `null` when it is not derivable,
   * and `undefined` when the server did not say (an older backend mid rolling
   * deploy, which is no information rather than a licence to guess).
   */
  directionAmount?: number | null;
}

/**
 * A schedule whose cash total is re-priced by the current FX rate: a top-level
 * investment schedule (its stored `amount` is the security-currency cash impact,
 * converted at the settlement rate) or a split parent carrying an investment
 * line (each line settles its own security's currency).
 *
 * Only used for the rolling-deploy fallback below -- a current backend answers
 * with `effectiveAmount` and this predicate is not consulted.
 */
function isFxSensitive(st: ScheduledTransaction): boolean {
  return (
    st.isInvestment === true ||
    (st.isSplit === true &&
      (st.splits?.some(
        s => s.investmentAction != null || s.kind === 'investment',
      ) ??
        false))
  );
}

/**
 * The amount every un-overridden occurrence of `st` would post today.
 *
 * Reads the server's `effectiveAmount` whenever the field is present -- `null`
 * included, which means "unknown", not "absent". An **absent** field is an older
 * backend mid rolling deploy, which is no information rather than a blessing of
 * the stored scalar: a schedule the current rate re-prices is reported unknown,
 * and one no rate touches keeps its stored amount (the same split
 * `lib/forecast.ts` makes for the cash-flow projection).
 */
export function scheduleEffectiveAmount(
  st: ScheduledTransaction,
): EffectiveScheduledAmount {
  const currencyCode = st.effectiveCurrencyCode ?? st.currencyCode;
  if (st.effectiveAmount !== undefined) {
    return {
      amount: st.effectiveAmount,
      currencyCode,
      complete: st.effectiveAmount !== null,
      directionAmount: st.effectiveDirectionAmount,
    };
  }
  if (isFxSensitive(st)) {
    return { amount: null, currencyCode, complete: false };
  }
  return { amount: Number(st.amount), currencyCode, complete: true };
}

/**
 * The amount the occurrence governed by `override` would post today, with the
 * same override-then-base precedence the posting applies: an override that
 * carries no amount of its own falls through to the base occurrence and inherits
 * its completeness.
 */
export function overrideEffectiveAmount(
  st: ScheduledTransaction,
  override: ScheduledTransactionOverride,
): EffectiveScheduledAmount {
  const base = scheduleEffectiveAmount(st);
  if (override.effectiveAmount !== undefined) {
    return {
      amount: override.effectiveAmount,
      currencyCode: base.currencyCode,
      complete: override.effectiveAmount !== null,
      directionAmount: override.effectiveDirectionAmount,
    };
  }
  // Older backend. An FX-sensitive schedule's override is re-priced the same way
  // its base is, so its stored scalar says nothing about today either.
  if (isFxSensitive(st)) {
    return { amount: null, currencyCode: base.currencyCode, complete: false };
  }
  if (override.amount != null) {
    return {
      amount: Number(override.amount),
      currencyCode: base.currencyCode,
      complete: true,
    };
  }
  return base;
}

/**
 * The amount the schedule's *next* occurrence would post today -- the one figure
 * a surface listing "what is coming up" should show. Honours the per-occurrence
 * override on that date when the server sent one.
 */
export function nextOccurrenceEffectiveAmount(
  st: ScheduledTransaction,
): EffectiveScheduledAmount {
  return st.nextOverride
    ? overrideEffectiveAmount(st, st.nextOverride)
    : scheduleEffectiveAmount(st);
}

/**
 * The date the schedule's *next* occurrence actually falls on.
 *
 * `nextDueDate` is the recurrence slot; an override addressed to that slot can
 * move the occurrence, and the moved date is when the money moves. A surface
 * that filters, sorts or prints the slot instead announces a payment on a day
 * the user has already changed -- the same defect as reading the persisted
 * amount, applied to the date (issue #1247).
 */
export function nextOccurrenceDueDate(st: ScheduledTransaction): string {
  return st.nextOverride?.overrideDate
    ? String(st.nextOverride.overrideDate).split('T')[0]
    : String(st.nextDueDate).split('T')[0];
}

/**
 * Convert and total a bucket of effective occurrence amounts into one currency.
 *
 * This exists instead of a currency-blind adder. The predecessor took the same
 * `EffectiveScheduledAmount` accessor and read only its `amount`, so it summed a
 * 1,350 CAD occurrence beside a 500 USD one and handed back 1,850 for a caller
 * to format in the reader's default currency -- a 23% overstatement presented as
 * a real figure. Passing the right `currencyCode` into it fixed nothing, because
 * it never looked. `sumConverted` cannot be called without saying how to convert.
 *
 * `convert` returns `null` for a pair with no rate, which keeps the total
 * withheld and names the currency; an occurrence whose own amount is unknown
 * arrives as `NaN` and is excluded by count, because it is unknown in every
 * currency and has no pair to blame. `map` applies the bucket's convention
 * (bills as positive magnitudes) *after* conversion. Check `isComplete` before
 * displaying the value: a caller either withholds an incomplete total or marks
 * it with `PartialTotal`, and never prints it under a total's own caption.
 */
export function sumEffectiveOccurrences<T>(
  items: readonly T[],
  effective: (item: T) => EffectiveScheduledAmount,
  convert: (amount: number, fromCurrency: string) => number | null,
  map: (amount: number) => number = amount => amount,
): ConvertedTotal {
  return sumConverted(
    items,
    item => effective(item).amount ?? NaN,
    item => effective(item).currencyCode,
    (amount, currency) => {
      const converted = convert(amount, currency);
      return converted === null ? null : map(converted);
    },
  );
}
