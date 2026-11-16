'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { formatNameList } from '@/lib/helpers/format-name-list';
import type {
  PayrollDeductionReport,
  PayrollReportCategory,
  PayrollReportPaycheque,
  PayrollReportPeriodTotal,
} from '@/types/payroll-deduction';

const MUTED = 'text-gray-400 dark:text-gray-500';
const NOTE = 'block text-xs text-gray-500 dark:text-gray-400';
const FOREIGN_NOTE = 'block text-xs text-amber-600 dark:text-amber-400';

/**
 * A category's column heading: its name, and its currency once the report
 * holds more than one, since two currencies of one category are two columns.
 */
export function categoryHeading(category: PayrollReportCategory, multiCurrency: boolean): string {
  return multiCurrency ? `${category.categoryName} (${category.currencyCode})` : category.categoryName;
}

/**
 * What one paycheque's cell holds for one category. The table shares one set
 * of rows across categories, but each category counts only its own period
 * (from its reset date) in its own currency, so an absent amount is one of
 * three things: a paycheque the category counted that deducted nothing to it
 * (a known zero), one outside the category's period, or one in another
 * currency. Only the first is zero; the other two were not counted for it.
 */
export function paychequeCell(
  category: PayrollReportCategory,
  paycheque: PayrollReportPaycheque,
): number | 'outsidePeriod' | 'otherCurrency' {
  const amount = paycheque.amounts[category.key];
  if (amount !== undefined) return amount;
  if (paycheque.currencyCode !== category.currencyCode) return 'otherCurrency';
  const { periodStart, periodEnd } = category.summary;
  if (paycheque.transactionDate < periodStart || paycheque.transactionDate > periodEnd) {
    return 'outsidePeriod';
  }
  return 0;
}

function SectionHeading({ title, help }: { title: string; help: string }) {
  return (
    <div className="flex items-center gap-1 px-4 pt-4 pb-2">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <InfoTooltip text={help} placement="bottom" />
    </div>
  );
}

function ForeignRowsNote({ count }: { count: number }) {
  const t = useTranslations('reports.payrollDeductions');
  if (count === 0) return null;
  return <span className={FOREIGN_NOTE}>{t('foreignRows', { count })}</span>;
}

function PeriodCell({ period }: { period: PayrollReportPeriodTotal }) {
  const t = useTranslations('reports.payrollDeductions');
  const { formatDate } = useDateFormat();
  return (
    <>
      {t('periodRange', { start: formatDate(period.periodStart), end: formatDate(period.periodEnd) })}
      {period.isCurrent && <span className={NOTE}>{t('toDate')}</span>}
    </>
  );
}

interface SummaryProps {
  report: PayrollDeductionReport;
}

/**
 * The selected year per category: what was paid against the maximum, the
 * paycheques it took and when the maximum was reached. A closed period's
 * maximum is not recorded (the rule holds only the figure it caps with now),
 * and the cell says so rather than showing today's figure against last year.
 */
export function PayrollDeductionsSummaryTable({ report }: SummaryProps) {
  const t = useTranslations('reports.payrollDeductions');
  const locale = useLocale();
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const { formatDate } = useDateFormat();

  return (
    <Card as="section" aria-label={t('summaryTitle', { year: report.year })}>
      <SectionHeading title={t('summaryTitle', { year: report.year })} help={t('summaryHelp')} />
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th>{t('colCategory')}</Th>
              <Th>{t('colPeriod')}</Th>
              <Th align="right">{t('colPaid')}</Th>
              <Th align="right">{t('colMaximum')}</Th>
              <Th align="right">{t('colRemaining')}</Th>
              <Th align="right">{t('colPercent')}</Th>
              <Th align="right">{t('colPaycheques')}</Th>
              <Th align="right">{t('colAverage')}</Th>
              <Th>{t('colReached')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {report.categories.map((category) => {
              const { summary, currencyCode } = category;
              const recorded = summary.yearlyMaximum !== null;
              return (
                <tr key={category.key}>
                  <Td>
                    {category.categoryName}
                    <span className={NOTE}>{formatNameList(locale, category.billNames)}</span>
                  </Td>
                  <Td>
                    <PeriodCell period={summary} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatCurrency(summary.paidToDate, currencyCode)}
                    <ForeignRowsNote count={summary.foreignCurrencyRows} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {summary.yearlyMaximum !== null ? (
                      formatCurrency(summary.yearlyMaximum, currencyCode)
                    ) : (
                      <span className={MUTED}>{t('notRecorded')}</span>
                    )}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {summary.remaining !== null ? (
                      formatCurrency(summary.remaining, currencyCode)
                    ) : (
                      <span className={MUTED}>{t('notRecorded')}</span>
                    )}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {summary.percentOfMaximum !== null ? (
                      formatPercent(summary.percentOfMaximum, 1)
                    ) : (
                      <span className={MUTED}>{t('notRecorded')}</span>
                    )}
                  </Td>
                  <Td align="right">{formatNumber(summary.paycheques, 0)}</Td>
                  <Td align="right" className="whitespace-nowrap">
                    {summary.averagePerPaycheque !== null ? (
                      formatCurrency(summary.averagePerPaycheque, currencyCode)
                    ) : (
                      <span className={MUTED}>{t('noPaycheque')}</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {summary.maximumReachedOn !== null ? (
                      formatDate(summary.maximumReachedOn)
                    ) : (
                      <span className={MUTED}>{recorded ? t('notReached') : t('notRecorded')}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Every transaction that deducted to a reported category in the selected
 * year, one column per category. The footer is each category's paid figure
 * from the summary, which the column adds up to by construction on the
 * server; the grand total is drawn only when every category shares one
 * currency, and otherwise says why it is missing.
 */
export function PayrollDeductionsPaychequeTable({ report }: SummaryProps) {
  const t = useTranslations('reports.payrollDeductions');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const multiCurrency = new Set(report.categories.map((c) => c.currencyCode)).size > 1;
  const title = t('paychequesTitle', { year: report.year });

  return (
    <Card as="section" aria-label={title}>
      <SectionHeading title={title} help={t('paychequesHelp')} />
      {report.paycheques.length === 0 ? (
        <p className="px-4 pb-6 pt-2 text-sm text-gray-500 dark:text-gray-400">
          {t('paychequesEmpty', { year: report.year })}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th>{t('colDate')}</Th>
                <Th>{t('colPayee')}</Th>
                {report.categories.map((category) => (
                  <Th key={category.key} align="right">
                    {categoryHeading(category, multiCurrency)}
                  </Th>
                ))}
                <Th align="right">{t('colTotal')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {report.paycheques.map((paycheque) => (
                <tr key={paycheque.transactionId}>
                  <Td className="whitespace-nowrap">{formatDate(paycheque.transactionDate)}</Td>
                  <Td>{paycheque.payeeName ?? <span className={MUTED}>{t('noPayee')}</span>}</Td>
                  {report.categories.map((category) => {
                    const cell = paychequeCell(category, paycheque);
                    return (
                      <Td key={category.key} align="right" className="whitespace-nowrap">
                        {typeof cell === 'number' ? (
                          <span className={cell === 0 && paycheque.amounts[category.key] === undefined ? MUTED : undefined}>
                            {formatCurrency(cell, category.currencyCode)}
                          </span>
                        ) : (
                          <span className={`${MUTED} text-xs`}>{t(cell)}</span>
                        )}
                      </Td>
                    );
                  })}
                  <Td align="right" className="whitespace-nowrap font-medium">
                    {formatCurrency(paycheque.total, paycheque.currencyCode)}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-200 dark:border-gray-700">
              <tr>
                <Td colSpan={2} className="font-semibold">
                  {t('totalRow')}
                </Td>
                {report.categories.map((category) => (
                  <Td key={category.key} align="right" className="whitespace-nowrap font-semibold">
                    {formatCurrency(category.summary.paidToDate, category.currencyCode)}
                  </Td>
                ))}
                <Td align="right" className="whitespace-nowrap font-semibold">
                  {report.total !== null && report.totalCurrencyCode !== null ? (
                    formatCurrency(report.total, report.totalCurrencyCode)
                  ) : (
                    <span className={`${MUTED} font-normal whitespace-normal text-xs`}>{t('mixedCurrencies')}</span>
                  )}
                </Td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

interface HistoryProps {
  category: PayrollReportCategory;
  multiCurrency: boolean;
}

/** One category's total for every period on record, newest first. */
export function PayrollDeductionsHistoryTable({ category, multiCurrency }: HistoryProps) {
  const t = useTranslations('reports.payrollDeductions');
  const { formatCurrency, formatNumber } = useNumberFormat();
  const title = multiCurrency
    ? t('historyTitleCurrency', { category: category.categoryName, currency: category.currencyCode })
    : t('historyTitle', { category: category.categoryName });

  return (
    <Card as="section" aria-label={title}>
      <SectionHeading title={title} help={t('historyHelp')} />
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th>{t('colYear')}</Th>
              <Th>{t('colPeriod')}</Th>
              <Th align="right">{t('colPaycheques')}</Th>
              <Th align="right">{t('colPaid')}</Th>
              <Th align="right">{t('colAverage')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {category.history.map((period) => (
              <tr key={period.periodStart}>
                <Td className="font-medium">{period.periodStart.slice(0, 4)}</Td>
                <Td>
                  <PeriodCell period={period} />
                </Td>
                <Td align="right">{formatNumber(period.paycheques, 0)}</Td>
                <Td align="right" className="whitespace-nowrap">
                  {formatCurrency(period.paidToDate, category.currencyCode)}
                  <ForeignRowsNote count={period.foreignCurrencyRows} />
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {period.averagePerPaycheque !== null ? (
                    formatCurrency(period.averagePerPaycheque, category.currencyCode)
                  ) : (
                    <span className={MUTED}>{t('noPaycheque')}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
