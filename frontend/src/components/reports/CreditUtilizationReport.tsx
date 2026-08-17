'use client';

import { useMemo, useRef } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  PieChart,
  Pie,
} from 'recharts';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { accountsApi } from '@/lib/accounts';
import {
  computeCreditRows,
  computeCreditTotals,
  type CreditUtilizationRow,
} from '@/lib/credit-utilization';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { ReportError } from '@/components/reports/ReportError';
import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';

// Only credit cards and lines of credit with a credit limit can have a
// meaningful utilization figure (used / available credit).
const isCreditAccount = (account: Account) =>
  (account.accountType === 'CREDIT_CARD' || account.accountType === 'LINE_OF_CREDIT') &&
  account.creditLimit != null &&
  account.creditLimit > 0 &&
  !account.isClosed;

type CreditUtilizationSortField =
  | 'name'
  | 'limit'
  | 'used'
  | 'available'
  | 'utilization';

// Utilization thresholds drive the bar colour: low (green), moderate (amber),
// high (red). 30% / 75% mirror the common "keep utilization under 30%" guidance.
function utilizationColour(percent: number): string {
  if (percent >= 75) return chartColors.expense;
  if (percent >= 30) return chartColors.warning;
  return chartColors.income;
}


/** One slice of the total-utilization donut: drawn vs available credit. */
interface TotalUtilizationSlice {
  key: 'used' | 'available';
  name: string;
  /** Amount in the report's display currency. */
  value: number;
  /** Share of the total credit limit. */
  percent: number;
  color: string;
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-credit-utilization-accounts';

export function CreditUtilizationReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { formatCurrency } = useNumberFormat();
  const { convert, defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);

  const { sortField, sortDirection, handleSort } = useSortableTable<CreditUtilizationSortField>(
    'reports.credit-utilization.sort',
    { field: 'utilization', direction: 'desc' },
  );

  const {
    data: accountsData,
    isLoading,
    error,
    reload,
  } = useReportData(
    () => accountsApi.getAll().then((all) => all.filter(isCreditAccount)),
    [],
  );

  const creditAccounts = useMemo(() => accountsData ?? [], [accountsData]);

  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    creditAccounts,
  );

  // An empty selection means "all credit accounts", matching the other reports.
  const activeAccounts = useMemo(
    () =>
      selectedAccountIds.length > 0
        ? creditAccounts.filter((a) => selectedAccountIds.includes(a.id))
        : creditAccounts,
    [creditAccounts, selectedAccountIds],
  );

  // When every selected account shares one currency, report in that currency;
  // any mix falls back to the user's home currency.
  const displayCurrency = useMemo(() => {
    const currencies = new Set(activeAccounts.map((a) => a.currencyCode));
    return currencies.size === 1 ? [...currencies][0] : defaultCurrency;
  }, [activeAccounts, defaultCurrency]);

  const isConverted = activeAccounts.some((a) => a.currencyCode !== displayCurrency);

  // The dashboard credit widgets share these helpers; the report uses the same
  // ones rather than a second copy of the null-exclusion logic.
  const rows = useMemo(
    () => computeCreditRows(activeAccounts, convert, displayCurrency),
    [activeAccounts, convert, displayCurrency],
  );

  /** A money figure, or a short "no rate" marker in its place. */
  const fmtOrUnknown = (value: number | null) =>
    value === null
      ? t('creditUtilization.noRate')
      : formatCurrency(value, displayCurrency);

  const totals = useMemo(() => computeCreditTotals(rows), [rows]);

  // The partial-total marker the money summary cards share.
  const totalsMarker = {
    missingCurrencies: totals.missingCurrencies,
    excludedCount: totals.excludedCount,
  };

  const sortedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'limit':
          comparison = compareValues(a.limit, b.limit);
          break;
        case 'used':
          comparison = compareValues(a.used, b.used);
          break;
        case 'available':
          comparison = compareValues(a.available, b.available);
          break;
        case 'utilization':
          comparison = compareValues(a.utilizationPercent, b.utilizationPercent);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [rows, sortField, sortDirection]);

  const accountTypeLabel = (type: Account['accountType']) =>
    type === 'LINE_OF_CREDIT'
      ? t('creditUtilization.typeLineOfCredit')
      : t('creditUtilization.typeCreditCard');

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = [
      t('creditUtilization.colAccount'),
      t('creditUtilization.colType'),
      t('creditUtilization.colCreditLimit'),
      t('creditUtilization.colUsed'),
      t('creditUtilization.colAvailable'),
      t('creditUtilization.colUtilization'),
    ];
    const exportRows = sortedRows.map((r) => [
      r.name,
      accountTypeLabel(r.accountType),
      fmtOrUnknown(r.limit),
      fmtOrUnknown(r.used),
      fmtOrUnknown(r.available),
      `${r.utilizationPercent.toFixed(1)}%`,
    ]);
    // A card with no rate is excluded from the totals, so the PDF marks them
    // partial rather than printing a subtotal as the whole.
    const pdfPartialSuffix =
      totals.excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : '';
    await exportToPdf({
      title: t('creditUtilization.pdfTitle'),
      summaryCards: [
        { label: t('creditUtilization.totalLimit'), value: `${formatCurrency(totals.limit, displayCurrency)}${pdfPartialSuffix}`, color: '#2563eb' },
        { label: t('creditUtilization.totalUsed'), value: `${formatCurrency(totals.used, displayCurrency)}${pdfPartialSuffix}`, color: '#dc2626' },
        { label: t('creditUtilization.totalAvailable'), value: `${formatCurrency(totals.available, displayCurrency)}${pdfPartialSuffix}`, color: '#16a34a' },
        { label: t('creditUtilization.overallUtilization'), value: `${totals.utilizationPercent.toFixed(1)}%${pdfPartialSuffix}`, color: '#ea580c' },
      ],
      chartContainer: chartRef.current,
      tableData: { headers, rows: exportRows },
      filename: 'credit-utilization',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && accountsData === null) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (creditAccounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('creditUtilization.empty')}
        </p>
      </div>
    );
  }

  // Scales with the account count; the chart container also stretches to fill
  // the row, so with few accounts the bars use the full height of the donut
  // column instead of leaving empty space below.
  const chartMinHeight = Math.max(200, sortedRows.length * 52);

  // The donut shows drawn credit (coloured by the same thresholds as the bars)
  // against remaining available credit (muted). Available is clamped at zero
  // so an over-limit balance still renders as a fully used pie.
  const availableForPie = Math.max(totals.available, 0);
  const totalPieData: TotalUtilizationSlice[] = [
    {
      key: 'used',
      name: t('creditUtilization.tooltipUsed'),
      value: totals.used,
      percent: totals.utilizationPercent,
      color: utilizationColour(totals.utilizationPercent),
    },
    {
      key: 'available',
      name: t('creditUtilization.tooltipAvailable'),
      value: availableForPie,
      percent: totals.limit > 0 ? (availableForPie / totals.limit) * 100 : 0,
      color: chartColors.grid,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Account Filter */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={creditAccounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
            filter={() => true}
          />
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Summary Cards. A card with no rate is excluded from the money totals
          and the utilisation ratio, so the figures are marked partial rather
          than reporting an improved ratio the excluded card would have worsened. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalLimit')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal total={{ value: totals.limit, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.limit, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalUsed')}</p>
          <p className="text-lg sm:text-xl font-bold text-red-600 dark:text-red-400">
            <PartialTotal total={{ value: totals.used, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.used, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalAvailable')}</p>
          <p className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            <PartialTotal total={{ value: totals.available, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.available, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.overallUtilization')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {totals.utilizationPercent.toFixed(1)}%
            {totals.excludedCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400" aria-hidden="true"> *</span>
            )}
          </p>
        </div>
      </div>
      {totals.missingCurrencies.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tCommon('partialTotal.explanation', {
            count: totals.excludedCount,
            displayCurrency,
            currencies: totals.missingCurrencies.join(', '),
          })}
        </p>
      )}

      {isConverted && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('creditUtilization.convertedNote', { currency: displayCurrency })}
        </p>
      )}

      {/* Utilization Charts */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="min-w-0 lg:col-span-2 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('creditUtilization.utilizationByAccount')}
            </h3>
            {/* The absolutely positioned inner div lets ResponsiveContainer
                track the stretched flex height without a feedback loop. */}
            <div className="relative flex-1" style={{ minHeight: chartMinHeight }}>
              <div className="absolute inset-0">
                <ResponsiveContainer minWidth={0}>
                  <BarChart data={sortedRows} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(value: number) => `${value}%`}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={120}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0].payload as CreditUtilizationRow;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{row.name}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipUtilization')}: {row.utilizationPercent.toFixed(1)}%
                            </p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipUsed')}: {fmtOrUnknown(row.used)}
                            </p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipAvailable')}: {fmtOrUnknown(row.available)}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine x={100} stroke={chartColors.axis} strokeDasharray="4 4" />
                    <Bar dataKey="utilizationPercent" radius={[0, 4, 4, 0]} maxBarSize={32}>
                      {sortedRows.map((row) => (
                        <Cell key={row.id} fill={utilizationColour(row.utilizationPercent)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('creditUtilization.totalUtilization')}
            </h3>
            <div className="relative mx-auto w-full max-w-xs" style={{ height: 240 }}>
              <ResponsiveContainer minWidth={0}>
                <PieChart>
                  <Pie
                    data={totalPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius="62%"
                    outerRadius="92%"
                    startAngle={90}
                    endAngle={-270}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {totalPieData.map((slice) => (
                      <Cell key={slice.key} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const slice = payload[0].payload as TotalUtilizationSlice;
                      return (
                        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                          <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {formatCurrency(slice.value, displayCurrency)} ({slice.percent.toFixed(1)}%)
                          </p>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {totals.utilizationPercent.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {totalPieData.map((slice) => (
                <div key={slice.key} className="flex items-center gap-2 text-sm">
                  <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: slice.color }} />
                  <span className="flex-1 text-gray-600 dark:text-gray-400">{slice.name}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(slice.value, displayCurrency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <SortableHeader<CreditUtilizationSortField>
                  field="name"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  {t('creditUtilization.colAccount')}
                </SortableHeader>
                <SortableHeader<CreditUtilizationSortField>
                  field="limit"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  {t('creditUtilization.colCreditLimit')}
                </SortableHeader>
                <SortableHeader<CreditUtilizationSortField>
                  field="used"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  {t('creditUtilization.colUsed')}
                </SortableHeader>
                <SortableHeader<CreditUtilizationSortField>
                  field="available"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  {t('creditUtilization.colAvailable')}
                </SortableHeader>
                <SortableHeader<CreditUtilizationSortField>
                  field="utilization"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  {t('creditUtilization.colUtilization')}
                </SortableHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedRows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <div className="flex flex-col">
                      <span>{row.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {accountTypeLabel(row.accountType)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                    {fmtOrUnknown(row.limit)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                    {fmtOrUnknown(row.used)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                    {fmtOrUnknown(row.available)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium" style={{ color: utilizationColour(row.utilizationPercent) }}>
                    {row.utilizationPercent.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                  {t('creditUtilization.total')}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrency(totals.limit, displayCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrency(totals.used, displayCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrency(totals.available, displayCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {totals.utilizationPercent.toFixed(1)}%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
