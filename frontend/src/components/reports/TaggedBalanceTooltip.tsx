'use client';

import { useTranslations } from 'next-intl';
import { ChartTooltip, type ChartTooltipEntry } from '@/components/reports/ChartTooltip';

/** The chart's series keys, in the order the Balance view lists them. */
export const BALANCE_TOOLTIP_ORDER = [
  'Income',
  'TaggedInflows',
  'Expenses',
  'TaggedOutflows',
  'Balance',
] as const;

export interface BalanceTooltipEntry extends ChartTooltipEntry {
  dataKey?: string | number;
}

/**
 * The tooltip rows of the Balance view: Income, Tagged inflows, Expenses,
 * Tagged outflows (only when this period has some), Balance. The chart's bars
 * are declared in drawing order, which is not reading order, so the rows are
 * ordered here and nothing else is listed.
 */
export function orderBalanceEntries(payload: BalanceTooltipEntry[]): BalanceTooltipEntry[] {
  const rank = (entry: BalanceTooltipEntry) =>
    BALANCE_TOOLTIP_ORDER.indexOf(entry.dataKey as (typeof BALANCE_TOOLTIP_ORDER)[number]);
  return payload
    .filter((entry) => rank(entry) >= 0)
    .filter((entry) => entry.dataKey !== 'TaggedOutflows' || (entry.value !== undefined && entry.value !== 0))
    .sort((a, b) => rank(a) - rank(b));
}

interface TaggedBalanceTooltipProps {
  active?: boolean;
  payload?: BalanceTooltipEntry[];
  formatValue: (value: number) => string;
  /** Formats a percentage already in percent units (-8.86 for -8.86%). */
  formatPercent: (percent: number) => string;
}

/**
 * Shared by Income vs Expenses and Cash Flow. The Balance % line is read from
 * the hovered row (`BalancePercent`), computed by `taggedBalance`; it is a dash
 * when the period has nothing coming in to divide by.
 */
export function TaggedBalanceTooltip({
  active,
  payload,
  formatValue,
  formatPercent,
}: TaggedBalanceTooltipProps) {
  const t = useTranslations('reports');
  const row = payload?.[0]?.payload as
    | { fullName?: string; BalancePercent?: number | null }
    | undefined;
  const percent = row?.BalancePercent;
  return (
    <ChartTooltip
      active={active}
      label={row?.fullName}
      payload={payload ? orderBalanceEntries(payload) : payload}
      formatValue={formatValue}
    >
      {row && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t('tagBreakdown.balancePercentTooltip', {
            rate: typeof percent === 'number' ? formatPercent(percent) : '—',
          })}
        </p>
      )}
    </ChartTooltip>
  );
}
