'use client';

import { PerformanceSummary } from '@/lib/monte-carlo';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useTranslations } from 'next-intl';
import type { NumberFormatters } from '@/hooks/useNumberFormat';
import { CAPTION_CLASS, CellLabel, Th } from '@/components/ui/Table';

// A value cell inside a wrapped row: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), this table's own `px-3 py-1.5`
// from `sm` up. The text size inherits `text-xs` from the table element at
// every width, so there is no per-cell size to preserve. `whitespace-nowrap` is
// not phone-only: a locale grouping thousands with a space could otherwise
// break a figure in the middle, at any width. A number must not break; the
// caption inside takes `whitespace-normal` back (CellLabel).
const VALUE_CELL = 'p-0 text-right whitespace-nowrap sm:table-cell sm:px-3 sm:py-1.5';

// The 50th-percentile column carries a highlight on both the header and the body
// cell, and it survives into the phone card so the median value still stands out.
const MEDIAN_HIGHLIGHT = 'bg-blue-50 dark:bg-blue-900/30';

export type SummaryRow = {
  label: string;
  description: string;
  band: PerformanceSummary[keyof PerformanceSummary];
  format: 'currency' | 'percent' | 'ratio';
};

// Kept for backward-compatibility in callers that only need English CSV/PDF headers.
export const PERFORMANCE_SUMMARY_HEADERS = [
  'Summary Statistics',
  '10th Percentile',
  '25th Percentile',
  '50th Percentile',
  '75th Percentile',
  '90th Percentile',
];

export type TranslationFn = (key: string) => string;

export function buildPerformanceSummaryRows(
  summary: PerformanceSummary,
  t?: TranslationFn,
): SummaryRow[] {
  const label = (key: string, fallback: string) => (t ? t(key) : fallback);
  return [
    {
      label: label('monteCarloPerformance.rowTwrNominalLabel', 'Time Weighted Rate of Return (nominal)'),
      description: label('monteCarloPerformance.rowTwrNominalDesc', 'Geometric mean of the simulated annual returns. Ignores cash flows and is reported in nominal terms (not adjusted for inflation).'),
      band: summary.twrNominal,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowTwrRealLabel', 'Time Weighted Rate of Return (real)'),
      description: label('monteCarloPerformance.rowTwrRealDesc', "Geometric mean of the simulated annual returns, adjusted for inflation so the result is in today's purchasing power."),
      band: summary.twrReal,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowEndBalanceNominalLabel', 'Portfolio End Balance (nominal)'),
      description: label('monteCarloPerformance.rowEndBalanceNominalDesc', 'Final portfolio value at the end of the simulation horizon, in future-dollar (nominal) terms.'),
      band: summary.endBalanceNominal,
      format: 'currency',
    },
    {
      label: label('monteCarloPerformance.rowEndBalanceRealLabel', 'Portfolio End Balance (real)'),
      description: label('monteCarloPerformance.rowEndBalanceRealDesc', "Final portfolio value discounted back to today's purchasing power using the inflation rate."),
      band: summary.endBalanceReal,
      format: 'currency',
    },
    {
      label: label('monteCarloPerformance.rowMeanReturnNominalLabel', 'Annual Mean Return (nominal)'),
      description: label('monteCarloPerformance.rowMeanReturnNominalDesc', 'Arithmetic average of the simulated annual returns. Always greater than or equal to the time-weighted return when volatility is non-zero.'),
      band: summary.meanReturnNominal,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowAnnualizedVolatilityLabel', 'Annualized Volatility'),
      description: label('monteCarloPerformance.rowAnnualizedVolatilityDesc', 'Standard deviation of the simulated annual returns — a measure of how much returns vary year-to-year.'),
      band: summary.annualizedVolatility,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowMaxDrawdownLabel', 'Maximum Drawdown'),
      description: label('monteCarloPerformance.rowMaxDrawdownDesc', 'Largest peak-to-trough drop in portfolio value during the simulation, including the effect of contributions and withdrawals.'),
      band: summary.maxDrawdown,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowMaxDrawdownExCashflowsLabel', 'Maximum Drawdown Excluding Cashflows'),
      description: label('monteCarloPerformance.rowMaxDrawdownExCashflowsDesc', 'Largest peak-to-trough drop driven purely by investment returns, ignoring contributions and withdrawals.'),
      band: summary.maxDrawdownExcludingCashflows,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowSafeWithdrawalRateLabel', 'Safe Withdrawal Rate'),
      description: label('monteCarloPerformance.rowSafeWithdrawalRateDesc', 'Largest constant inflation-adjusted withdrawal, expressed as a percentage of the starting balance, that exactly depletes the portfolio at the end of the horizon.'),
      band: summary.safeWithdrawalRate,
      format: 'percent',
    },
    {
      label: label('monteCarloPerformance.rowPerpetualWithdrawalRateLabel', 'Perpetual Withdrawal Rate'),
      description: label('monteCarloPerformance.rowPerpetualWithdrawalRateDesc', 'Largest constant inflation-adjusted withdrawal, as a percentage of the starting balance, that preserves the real value of the portfolio at the end of the horizon.'),
      band: summary.perpetualWithdrawalRate,
      format: 'percent',
    },
  ];
}

export function formatSummaryValue(
  v: number,
  kind: SummaryRow['format'],
  formatters: NumberFormatters,
): string {
  if (!Number.isFinite(v)) return '—';
  if (kind === 'currency') return formatters.formatCurrency(v);
  // The band values are fractions (0.1234 = 12.34%); the formatter takes
  // percentage units.
  if (kind === 'percent') return formatters.formatPercent(v * 100, 2);
  // A ratio is still a number a person reads, so it takes the same separators.
  return formatters.formatNumber(v, 2);
}

export function PerformanceSummaryTable({
  summary,
  formatters,
}: {
  summary: PerformanceSummary;
  formatters: NumberFormatters;
}) {
  const t = useTranslations('reports');
  const rows = buildPerformanceSummaryRows(summary, t as TranslationFn);
  const formatValue = (v: number, kind: SummaryRow['format']): string =>
    formatSummaryValue(v, kind, formatters);

  return (
    // Below `sm` the table becomes a block and each row wraps into a two-track
    // grid card so all six columns fit a phone without a horizontal scroll: line
    // 1 is the statistic's label (the row identity, with its info tooltip),
    // spanning both tracks; lines 2 to 4 carry the five percentile values two to
    // a line, the 90th alone on the last. Nothing is dropped, and no value wraps
    // (`VALUE_CELL`). From `sm` up it is the ordinary table, each cell restoring
    // its own `px-3 py-1.5` and the table's `text-xs` inherited at every width,
    // so at 640px+ it resolves to today's output in every respect but one:
    // `VALUE_CELL`'s `whitespace-nowrap` is unprefixed, so it applies there as
    // well, where the base cell carried no `white-space` class. That is
    // deliberate and the constant says why. This table's header is not
    // sortable, so below `sm` the column header row is simply block-hidden and
    // every bare value carries a `CellLabel` naming its column; the label names
    // itself. The 50th-percentile highlight follows its column into the card.
    // Restyling `display` strips the implicit table semantics, so the ARIA roles
    // are restated; the phone grid places cells out of DOM order, which stays
    // the desktop column order.
    <div className="overflow-x-auto">
      <table role="table" className="block min-w-full text-xs sm:table">
        <thead
          role="rowgroup"
          className="hidden bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 sm:table-header-group"
        >
          <tr role="row">
            <Th role="columnheader" className="px-3 py-2">
              {t('monteCarloPerformance.colSummaryStatistics')}
            </Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloPerformance.col10thPercentile')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloPerformance.col25thPercentile')}</Th>
            <Th role="columnheader" align="right" className={`px-3 py-2 font-semibold text-gray-700 dark:text-gray-200 ${MEDIAN_HIGHLIGHT}`}>
              {t('monteCarloPerformance.col50thPercentile')}
            </Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloPerformance.col75thPercentile')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloPerformance.col90thPercentile')}</Th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group"
        >
          {rows.map((row) => (
            <tr
              key={row.label}
              role="row"
              className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-3 py-2 sm:table-row sm:p-0"
            >
              {/* The statistic's label is the row identity, so it carries no
                  caption; it spans both tracks and wraps on a phone. */}
              <td role="cell" className="col-start-1 col-span-2 row-start-1 p-0 text-gray-900 dark:text-gray-100 break-words sm:table-cell sm:px-3 sm:py-1.5 sm:break-normal">
                {row.label}
                <InfoTooltip text={row.description} />
              </td>
              <td role="cell" className={`col-start-1 row-start-2 ${VALUE_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloPerformance.col10thPercentile')}</CellLabel>
                {formatValue(row.band.p10, row.format)}
              </td>
              <td role="cell" className={`col-start-2 row-start-2 ${VALUE_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloPerformance.col25thPercentile')}</CellLabel>
                {formatValue(row.band.p25, row.format)}
              </td>
              <td role="cell" className={`col-start-1 row-start-3 font-semibold text-gray-900 dark:text-gray-100 ${MEDIAN_HIGHLIGHT} ${VALUE_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloPerformance.col50thPercentile')}</CellLabel>
                {formatValue(row.band.p50, row.format)}
              </td>
              <td role="cell" className={`col-start-2 row-start-3 ${VALUE_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloPerformance.col75thPercentile')}</CellLabel>
                {formatValue(row.band.p75, row.format)}
              </td>
              <td role="cell" className={`col-start-1 row-start-4 ${VALUE_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloPerformance.col90thPercentile')}</CellLabel>
                {formatValue(row.band.p90, row.format)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
