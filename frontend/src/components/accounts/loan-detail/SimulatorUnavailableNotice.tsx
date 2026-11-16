'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import type { LoanProjectionUnavailableReason } from '@/lib/loan-history';

/**
 * Shown in place of the overpayment simulator when the loan cannot be projected.
 * The simulator needs a forward schedule, and `buildLoanProjectionInput` returns
 * none when a required input is missing -- so rather than draw nothing (which
 * reads as "the feature is gone"), name the reason and how to fix it. The reason
 * comes from `diagnoseLoanProjection`, the same evaluation that decides whether
 * the simulator renders at all, so the two cannot disagree.
 */
export function SimulatorUnavailableNotice({
  reason,
}: {
  reason: LoanProjectionUnavailableReason;
}) {
  const t = useTranslations('accounts');
  const reasonKey: Record<LoanProjectionUnavailableReason, string> = {
    'paid-off': 'loanDetail.simulator.unavailable.reasonPaidOff',
    'no-frequency': 'loanDetail.simulator.unavailable.reasonNoFrequency',
    'no-rate': 'loanDetail.simulator.unavailable.reasonNoRate',
    'no-payment': 'loanDetail.simulator.unavailable.reasonNoPayment',
    'no-amortization': 'loanDetail.simulator.unavailable.reasonNoAmortization',
    'no-payment-start': 'loanDetail.simulator.unavailable.reasonNoPaymentStart',
    'no-principal': 'loanDetail.simulator.unavailable.reasonNoPrincipal',
  };
  return (
    <Card padding="md">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('loanDetail.simulator.title')}
      </h3>
      <p className="text-sm text-amber-700 dark:text-amber-400">
        {t('loanDetail.simulator.unavailable.title')}
      </p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
        {t(reasonKey[reason])}
      </p>
    </Card>
  );
}
