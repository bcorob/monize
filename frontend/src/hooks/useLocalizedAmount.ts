import { useCallback } from 'react';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { formatAmountLocalized } from '@/lib/number-parse';

/**
 * Read-only amount formatter bound to the user's number locale: grouped, fixed
 * decimals, WITHOUT a currency symbol (the symbol is composed separately at the
 * call site). One definition of the "seps default + effective locale" closure
 * that the register row, the split editor and the scheduled-transaction row all
 * need -- CLAUDE.md's "exists once" rule, so a fourth surface reuses this rather
 * than copying the closure again.
 *
 * The defensive `?? { decimal: '.', group: ',' }` lives here, so a component
 * whose `useNumberFormat` is only partially mocked (or an older build mid rolling
 * deploy) still formats in en-US rather than crashing -- and because this hook
 * composes the (possibly mocked) `useNumberFormat` rather than being mocked
 * itself, those tests need no change.
 */
export function useLocalizedAmount(): (
  value: number | undefined | null,
  decimals?: number,
) => string {
  const { numberSeparators, numberLocale } = useNumberFormat();
  const decimal = numberSeparators?.decimal ?? '.';
  const group = numberSeparators?.group ?? ',';
  return useCallback(
    (value: number | undefined | null, decimals: number = 2) =>
      formatAmountLocalized(value, decimals, { decimal, group }, numberLocale),
    [decimal, group, numberLocale],
  );
}
