import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { isComplete, type ConvertedTotal } from '@/lib/currency-total';

/**
 * What an export prints beside a figure that is a subtotal.
 *
 * `PartialTotal` is the screen's marker; a PDF has no hover, so the same fact is
 * a sentence under the value (`PdfSummaryCard.note`) or a suffix on a table cell.
 * Both read `isComplete`, the one definition of "nothing was excluded", so a
 * figure the screen marks is a figure the document marks.
 */
export function usePartialTotalNote() {
  const t = useTranslations('reports');

  /** The note for a card, or `undefined` when the total is complete. */
  const noteFor = useCallback(
    (total: ConvertedTotal): string | undefined => {
      if (isComplete(total)) return undefined;
      return total.missingCurrencies.length > 0
        ? t('partialData.pdfNote', { currencies: total.missingCurrencies.join(', ') })
        : t('partialData.pdfNoteExcluded', { count: total.excludedCount });
    },
    [t],
  );

  /** A formatted figure for a table cell, suffixed when its total is partial. */
  const cellFor = useCallback(
    (text: string, total: ConvertedTotal): string =>
      isComplete(total) ? text : `${text} ${t('partialData.pdfSuffix')}`,
    [t],
  );

  return { noteFor, cellFor };
}
