'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { Select } from '@/components/ui/Select';
import { ReportError } from '@/components/reports/ReportError';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import {
  categoryHeading,
  PayrollDeductionsHistoryTable,
  PayrollDeductionsPaychequeTable,
  PayrollDeductionsSummaryTable,
  paychequeCell,
} from '@/components/reports/PayrollDeductionsReportTables';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useReportData } from '@/hooks/useReportData';
import { exportCsvSections, type CsvSection } from '@/lib/csv-export';
import { payrollDeductionsApi } from '@/lib/payroll-deductions';
import type { PayrollDeductionReport } from '@/types/payroll-deduction';

/**
 * The payroll deductions report (docs/specs/payroll-deductions.md section
 * 10): for the selected year, each ruled category's paid figure against its
 * maximum and the paycheques that made it up, then one table per category
 * of every year on record. Every figure is the server's; the report draws
 * them and adds nothing up itself.
 */
export function PayrollDeductionsReport() {
  const t = useTranslations('reports.payrollDeductions');
  const today = useFinancialToday();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));

  const { data: report, isLoading, error, reload } = useReportData(
    () => payrollDeductionsApi.report(year),
    [year],
  );

  // The year being drawn keeps the select's options until the next answer.
  const years = report?.availableYears ?? [year];

  const handleExportCsv = () => {
    if (report) exportCsvSections(`payroll-deductions-${report.year}`, csvSections(report, t));
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          {/* The label sits beside the picker, which only ever holds a 4-digit year. */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="payroll-report-year"
              className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap"
            >
              {t('year')}
            </label>
            <div className="w-28">
              <Select
                id="payroll-report-year"
                value={String(year)}
                onChange={(e) => setYear(Number(e.target.value))}
                options={years.map((y) => ({ value: String(y), label: String(y) }))}
              />
            </div>
            <InfoTooltip text={t('yearHelp')} placement="bottom" />
          </div>
          <ReportToolbarActions onExportCsv={handleExportCsv} disabled={!report || report.categories.length === 0} />
        </div>
      </Card>

      {error ? (
        <ReportError onRetry={reload} />
      ) : isLoading || !report ? (
        <Card className="p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </Card>
      ) : report.categories.length === 0 ? (
        <Card>
          <EmptyState
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            action={
              <Link
                href="/taxes/payroll-deductions"
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
              >
                {t('emptyAction')}
              </Link>
            }
          />
        </Card>
      ) : (
        <PayrollDeductionsReportBody report={report} />
      )}
    </div>
  );
}

function PayrollDeductionsReportBody({ report }: { report: PayrollDeductionReport }) {
  const multiCurrency = new Set(report.categories.map((c) => c.currencyCode)).size > 1;
  return (
    <>
      <PayrollDeductionsSummaryTable report={report} />
      <PayrollDeductionsPaychequeTable report={report} />
      {report.categories.map((category) => (
        <PayrollDeductionsHistoryTable key={category.key} category={category} multiCurrency={multiCurrency} />
      ))}
    </>
  );
}

type Translate = ReturnType<typeof useTranslations<'reports.payrollDeductions'>>;

/**
 * The three parts of the report as CSV sections, figures as the server sent
 * them (a machine surface: ISO dates, unformatted numbers, an empty cell for
 * a figure that is not recorded).
 */
export function csvSections(report: PayrollDeductionReport, t: Translate): CsvSection[] {
  const multiCurrency = new Set(report.categories.map((c) => c.currencyCode)).size > 1;
  const summary: CsvSection = {
    title: t('csvSummary'),
    headers: [
      t('colCategory'),
      t('colBills'),
      t('colPeriod'),
      t('colPaid'),
      t('colMaximum'),
      t('colRemaining'),
      t('colPercent'),
      t('colPaycheques'),
      t('colAverage'),
      t('colReached'),
    ],
    rows: report.categories.map((category) => [
      categoryHeading(category, multiCurrency),
      category.billNames.join('; '),
      `${category.summary.periodStart} - ${category.summary.periodEnd}`,
      category.summary.paidToDate,
      category.summary.yearlyMaximum ?? '',
      category.summary.remaining ?? '',
      category.summary.percentOfMaximum ?? '',
      category.summary.paycheques,
      category.summary.averagePerPaycheque ?? '',
      category.summary.maximumReachedOn ?? '',
    ]),
  };
  const paycheques: CsvSection = {
    title: t('csvPaycheques'),
    headers: [
      t('colDate'),
      t('colPayee'),
      ...report.categories.map((c) => categoryHeading(c, multiCurrency)),
      t('colTotal'),
    ],
    rows: report.paycheques.map((p) => [
      p.transactionDate,
      p.payeeName ?? '',
      // A cell the category did not count (another period or currency) is empty, not zero.
      ...report.categories.map((c) => {
        const cell = paychequeCell(c, p);
        return typeof cell === 'number' ? cell : '';
      }),
      p.total,
    ]),
  };
  const history: CsvSection[] = report.categories.map((category) => ({
    title: multiCurrency
      ? t('historyTitleCurrency', { category: category.categoryName, currency: category.currencyCode })
      : t('historyTitle', { category: category.categoryName }),
    headers: [t('colYear'), t('colPeriod'), t('colPaycheques'), t('colPaid'), t('colAverage')],
    rows: category.history.map((p) => [
      p.periodStart.slice(0, 4),
      `${p.periodStart} - ${p.periodEnd}`,
      p.paycheques,
      p.paidToDate,
      p.averagePerPaycheque ?? '',
    ]),
  }));
  return [summary, paycheques, ...history];
}
