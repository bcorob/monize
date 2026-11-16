'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { ConvertedTotal } from '@/lib/currency-total';

export type FundsTone = 'green' | 'indigo' | 'blue' | 'red' | 'purple' | 'gray';

const TONE_CLASS: Record<FundsTone, string> = {
  green: 'text-green-600 dark:text-green-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  blue: 'text-blue-600 dark:text-blue-400',
  red: 'text-red-600 dark:text-red-400',
  purple: 'text-purple-600 dark:text-purple-400',
  gray: 'text-gray-900 dark:text-gray-100',
};

export interface FundsFigure {
  key: string;
  label: string;
  /** Null renders as a dash: unknown, never 0. */
  value: number | null;
  kind: 'money' | 'percent';
  tone: FundsTone;
  /** A money figure that is a subtotal is marked through `PartialTotal`. */
  completeness?: ConvertedTotal;
}

interface TaggedFundsStripProps {
  status: 'loading' | 'error' | 'ready';
  figures: FundsFigure[];
  currency: string;
  /** A short line under the figures (for example why no funding figure is shown). */
  note?: string;
}

/**
 * The labelled funding figures of one window
 * (`docs/specs/report-tag-key-breakdown.md` section 11.3 and 11.4): income,
 * tagged transfers, available funds and, where the report has an expense total,
 * Spent and Balance. Dumb on purpose: the caller derives every figure through
 * `lib/tagged-balance.ts`, so the arithmetic is written once. A failed request
 * says so rather than showing missing data (the contract's s.1.3).
 */
export function TaggedFundsStrip({ status, figures, currency, note }: TaggedFundsStripProps) {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();

  return (
    <Card padding="sm" data-testid="tagged-funds-strip">
      {status === 'loading' ? (
        <Skeleton className="h-12 w-full" />
      ) : status === 'error' ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {t('tagBreakdown.fundsLoadFailed')}
        </p>
      ) : (
        <>
          {figures.length > 0 && (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {figures.map((figure) => (
              <div key={figure.key} className="min-w-0">
                <dt className="text-xs text-gray-500 dark:text-gray-400 break-words">{figure.label}</dt>
                <dd className={`text-lg font-semibold ${TONE_CLASS[figure.tone]}`}>
                  {figure.value === null ? (
                    '—'
                  ) : figure.kind === 'percent' ? (
                    formatPercent(figure.value, 2)
                  ) : figure.completeness ? (
                    <PartialTotal total={figure.completeness} displayCurrency={currency}>
                      {formatCurrency(figure.value)}
                    </PartialTotal>
                  ) : (
                    formatCurrency(figure.value)
                  )}
                </dd>
              </div>
            ))}
          </dl>
          )}
          {note && <p className={`${figures.length > 0 ? 'mt-3 ' : ''}text-sm text-gray-500 dark:text-gray-400`}>{note}</p>}
        </>
      )}
    </Card>
  );
}
