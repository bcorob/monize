'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { payrollDeductionsApi } from '@/lib/payroll-deductions';
import type { PayrollDeductionHistory } from '@/types/payroll-deduction';

const logger = createLogger('PayrollDeductionPreviousPeriods');

/**
 * What each ruled category collected in its closed periods, newest first,
 * one row per category and period. Loaded when the section is opened: the
 * page keeps it collapsed, and the figures are a look back, not a decision.
 */
export function PayrollDeductionPreviousPeriods() {
  const t = useTranslations('taxes.payroll');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [history, setHistory] = useState<PayrollDeductionHistory[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const rows = await payrollDeductionsApi.history();
        if (!cancelled) setHistory(rows);
      } catch (error) {
        toast.error(getErrorMessage(error, t('previousPeriods.loadFailed')));
        logger.error(error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const rows = (history ?? []).flatMap((category) =>
    category.periods.map((period) => ({ category, period })),
  );

  return (
    <section aria-label={t('previousPeriods.title')}>
      <div className="flex items-center gap-1 px-4 pt-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('previousPeriods.title')}</h2>
        <InfoTooltip text={t('previousPeriods.help')} placement="bottom" />
      </div>
      {isLoading ? (
        <LoadingSpinner text={t('previousPeriods.loading')} />
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">{t('previousPeriods.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th>{t('list.category')}</Th>
                <Th>{t('list.period')}</Th>
                <Th align="right">{t('list.paid')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {rows.map(({ category, period }) => (
                <tr key={`${category.categoryId}|${category.currencyCode}|${period.periodStart}`}>
                  <Td>{category.categoryName}</Td>
                  <Td>
                    {t('list.periodRange', {
                      start: formatDate(period.periodStart),
                      end: formatDate(period.periodEnd),
                    })}
                  </Td>
                  <Td align="right">
                    {formatCurrency(period.paidToDate, category.currencyCode)}
                    {period.foreignCurrencyRows > 0 && (
                      <span className="block text-xs text-amber-600 dark:text-amber-400">
                        {t('yearToDate.foreignRows', { count: period.foreignCurrencyRows })}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
