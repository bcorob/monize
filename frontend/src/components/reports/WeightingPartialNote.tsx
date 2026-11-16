'use client';

import { useTranslations } from 'next-intl';
import type { WeightingCompleteness } from '@/types/investment';

/**
 * Says why a weighting result is partial and what to do: percentages are shares
 * of the known part, and the securities and currency pairs left out are named.
 * Renders nothing unless the server sent `valuationComplete === false`.
 */
export function WeightingPartialNote({ result }: { result: WeightingCompleteness | null | undefined }) {
  const t = useTranslations('reports');
  if (!result || result.valuationComplete !== false) return null;

  const symbols = result.unpricedSymbols ?? [];
  const pairs = result.missingRatePairs ?? [];
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="weighting-partial-note">
      {t('partialData.weightingIntro')}
      {symbols.length > 0 && ` ${t('partialData.weightingNoPrice', { symbols: symbols.join(', ') })}`}
      {pairs.length > 0 && ` ${t('partialData.weightingNoRate', { pairs: pairs.join(', ') })}`}
    </p>
  );
}
