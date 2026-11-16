'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { ReceiptMatchTrace } from '@/types/email-receipts';

interface MatchTraceViewProps {
  trace: ReceiptMatchTrace;
}

/**
 * What the matcher looked at when a profile was tested (design 5.5): the window
 * around the purchase date, the amount tolerance, and for each strategy, in the
 * order tried, how many transactions it kept (the first few are listed) and
 * which one decided. A strategy after the deciding one is not listed: the matcher
 * never ran it. Every figure is read from the answer, nothing is recomputed here.
 */
export function MatchTraceView({ trace }: MatchTraceViewProps) {
  const t = useTranslations('emailReceipts.test.trace');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  return (
    <div className="space-y-2 text-xs text-gray-600 dark:text-gray-400">
      <p className="font-medium text-gray-900 dark:text-gray-100">{t('heading')}</p>
      <p>
        {t('window', {
          from: formatDate(trace.window.from),
          to: formatDate(trace.window.to),
          before: trace.daysBefore,
          after: trace.daysAfter,
          considered: trace.considered,
        })}
        {trace.toleranceUnits > 0 && (
          <>
            {' '}
            {t('tolerance', { amount: formatCurrency(fromReceiptUnits(trace.toleranceUnits)) })}
          </>
        )}
      </p>
      <ol className="space-y-2">
        {trace.attempts.map((attempt, index) => (
          <li key={attempt.strategy}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {t('attempt', { position: index + 1, name: t(`strategies.${attempt.strategy}`) })}
              </span>
              <span>{t('kept', { count: attempt.count })}</span>
              {trace.decidedBy === attempt.strategy && <Badge variant="green">{t('decided')}</Badge>}
            </div>
            {attempt.transactions.length > 0 && (
              <ul className="ml-4 mt-1 list-disc">
                {attempt.transactions.map((transaction) => (
                  <li key={transaction.id}>
                    {t('transaction', {
                      date: formatDate(transaction.date),
                      amount: formatCurrency(transaction.amount),
                      payee: transaction.payeeName ?? t('noPayee'),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
