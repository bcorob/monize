'use client';

import { useLocale, useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PayrollDeductionRule } from '@/types/payroll-deduction';
import { formatNameList } from '@/lib/helpers/format-name-list';

/** One row of the table: a category's room, shared by every bill that caps it. */
export interface YearToDateRow {
  key: string;
  categoryName: string;
  billNames: string[];
  periodStart: string;
  periodEnd: string;
  paidToDate: number;
  foreignCurrencyRows: number;
  yearlyMaximum: number;
  remaining: number;
  currencyCode: string;
}

/**
 * One row per category, currency and period. `paidToDate` is category-wide
 * on the server, so two paycheques capping the same category over the same
 * period carry the same figure; showing it twice would read as twice the
 * money. Where their maxima differ, the lower one binds, as it does in the
 * forecast's pooled room. Rules anchored on different reset dates measure
 * different periods, so they stay apart.
 */
export function groupYearToDateRows(rules: PayrollDeductionRule[]): YearToDateRow[] {
  const rows = new Map<string, YearToDateRow>();
  for (const rule of rules) {
    const key = `${rule.categoryId}|${rule.currencyCode}|${rule.periodStart}|${rule.periodEnd}`;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        key,
        categoryName: rule.categoryName,
        billNames: [rule.scheduledTransactionName],
        periodStart: rule.periodStart,
        periodEnd: rule.periodEnd,
        paidToDate: rule.paidToDate,
        foreignCurrencyRows: rule.foreignCurrencyRows,
        yearlyMaximum: rule.yearlyMaximum,
        remaining: rule.remaining,
        currencyCode: rule.currencyCode,
      });
      continue;
    }
    if (!row.billNames.includes(rule.scheduledTransactionName)) {
      row.billNames.push(rule.scheduledTransactionName);
    }
    row.yearlyMaximum = Math.min(row.yearlyMaximum, rule.yearlyMaximum);
    row.remaining = Math.min(row.remaining, rule.remaining);
  }
  return Array.from(rows.values());
}

interface PayrollDeductionYearToDateProps {
  rules: PayrollDeductionRule[];
}

/**
 * What each rule's category has collected in the period containing today,
 * as the server read it (docs/specs/payroll-deductions.md decision 6). A row
 * says when rows in another currency were left out, so the paid figure is
 * read as the lower bound it then is.
 */
export function PayrollDeductionYearToDate({ rules }: PayrollDeductionYearToDateProps) {
  const t = useTranslations('taxes.payroll');
  const locale = useLocale();
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const rows = groupYearToDateRows(rules);

  return (
    <section aria-label={t('yearToDate.title')}>
      <div className="flex items-center gap-1 px-4 pt-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('yearToDate.title')}</h2>
        <InfoTooltip text={t('yearToDate.help')} placement="bottom" />
      </div>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th>{t('list.bill')}</Th>
              <Th>{t('list.category')}</Th>
              <Th>{t('list.period')}</Th>
              <Th align="right">{t('list.paid')}</Th>
              <Th align="right">{t('list.yearlyMaximum')}</Th>
              <Th align="right">{t('list.remaining')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {rows.map((rule) => (
              <tr key={rule.key}>
                <Td>{formatNameList(locale, rule.billNames)}</Td>
                <Td>{rule.categoryName}</Td>
                <Td>
                  {t('list.periodRange', {
                    start: formatDate(rule.periodStart),
                    end: formatDate(rule.periodEnd),
                  })}
                </Td>
                <Td align="right">
                  {formatCurrency(rule.paidToDate, rule.currencyCode)}
                  {rule.foreignCurrencyRows > 0 && (
                    <span className="block text-xs text-amber-600 dark:text-amber-400">
                      {t('yearToDate.foreignRows', { count: rule.foreignCurrencyRows })}
                    </span>
                  )}
                </Td>
                <Td align="right">{formatCurrency(rule.yearlyMaximum, rule.currencyCode)}</Td>
                <Td align="right">{formatCurrency(rule.remaining, rule.currencyCode)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
