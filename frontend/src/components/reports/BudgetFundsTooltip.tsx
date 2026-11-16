'use client';

import { useTranslations } from 'next-intl';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { BudgetFundsPoint } from '@/lib/budget-available-funds';

interface BudgetFundsTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: BudgetFundsPoint }>;
  label?: string;
  /** The month as the chart axis shows it. */
  formatMonth: (monthKey: string) => string;
  /** True when a missing rate left Available funds a subtotal. */
  partial: boolean;
}

const DASH = '—';

/**
 * The overview chart's tooltip while the funding view is on
 * (`docs/specs/report-tag-key-breakdown.md` section 11.6): the Budgeted and
 * Actual rows as they always were, then Available funds and Actual vs available.
 * A month with no funding figure shows a dash, never 0, and a figure that is a
 * subtotal carries an asterisk.
 */
export function BudgetFundsTooltip({ active, payload, label, formatMonth, partial }: BudgetFundsTooltipProps) {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const mark = partial ? '*' : '';
  const money = (value: number | null) => (value === null ? DASH : `${formatCurrency(value)}${mark}`);

  return (
    <ChartTooltipPanel>
      <p className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">{formatMonth(String(label ?? point.monthKey))}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('budgetVsActual.seriesBudgeted')}: {formatCurrency(point.budgeted)}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('budgetVsActual.seriesActual')}: {formatCurrency(point.actual)}
      </p>
      <p className="text-sm text-indigo-600 dark:text-indigo-400">
        {t('tagBreakdown.fundsAvailable')}: {money(point.availableFunds)}
      </p>
      <p className="text-sm text-gray-900 dark:text-gray-100">
        {t('tagBreakdown.actualVsAvailable')}: {money(point.actualVsAvailable)}
      </p>
    </ChartTooltipPanel>
  );
}
