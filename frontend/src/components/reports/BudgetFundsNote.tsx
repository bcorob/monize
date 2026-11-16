'use client';

import { useTranslations } from 'next-intl';

interface BudgetFundsNoteProps {
  status: 'off' | 'loading' | 'error' | 'ready';
  /** Currencies a missing rate left out of Available funds; empty when complete. */
  missingCurrencies: string[];
  /** True when the series is a set of subtotals. */
  partial: boolean;
}

/**
 * What the funding view of Budget vs Actual has to say that the chart cannot
 * (`docs/specs/report-tag-key-breakdown.md` section 11.6): a failed request is
 * said to be one, and a missing exchange rate names the currencies that left
 * Available funds a subtotal. Nothing while the figures are loading or whole.
 */
export function BudgetFundsNote({ status, missingCurrencies, partial }: BudgetFundsNoteProps) {
  const t = useTranslations('reports');
  if (status === 'error') {
    return (
      <p className="text-sm text-red-600 dark:text-red-400" role="alert">
        {t('tagBreakdown.fundsLoadFailed')}
      </p>
    );
  }
  if (status === 'ready' && partial) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        {missingCurrencies.length > 0
          ? t('tagBreakdown.budgetFundsPartialNote', { currencies: missingCurrencies.join(', ') })
          : t('tagBreakdown.budgetFundsPartialNoteGeneric')}
      </p>
    );
  }
  return null;
}
