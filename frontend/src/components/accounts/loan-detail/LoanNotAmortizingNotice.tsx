'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { LoanNotAmortizingReason } from '@/lib/loan-figures';

/**
 * Explains why a loan's payoff date and remaining interest are unknown when the
 * projection does not reach zero. Both figures render "unknown" on the summary
 * cards, and this says which of the two reasons applies -- most often a payment
 * below the current interest, which the user can fix by recording the real
 * installment. Drawn from `loanNotAmortizingReason`, the same schedule the cards
 * read, so it cannot claim a reason the figures do not have.
 */
export function LoanNotAmortizingNotice({
  reason,
  currencyCode,
}: {
  reason: LoanNotAmortizingReason;
  currencyCode: string;
}) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  return (
    <Card padding="md">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
        {t('loanDetail.notAmortizing.title')}
      </p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        {reason.kind === 'payment-below-interest'
          ? t('loanDetail.notAmortizing.paymentBelowInterest', {
              payment: formatCurrency(reason.payment, currencyCode),
              interest: formatCurrency(reason.periodInterest, currencyCode),
              rate: reason.annualRate,
            })
          : t('loanDetail.notAmortizing.beyondHorizon')}
      </p>
    </Card>
  );
}
