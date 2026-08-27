'use client';

import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { PastImpactResult } from '@/lib/loan-past-impact';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';

interface PastImpactSectionProps {
  account: Account;
  /**
   * Precomputed by the parent, which also feeds `originalSchedule` into the
   * payoff chart's contractual curve -- so the "already saved" figures here and
   * the actual-vs-contractual gap on that chart come from the same source.
   */
  impact: PastImpactResult | null;
}

/**
 * How overpayments already made have shortened the loan -- extra principal
 * paid, months saved, and interest saved versus the original contractual
 * schedule -- shown as a plain card row that continues the summary figures
 * above it. The balance-over-time comparison lives in the shared payoff chart.
 */
export function PastImpactSection({ account, impact }: PastImpactSectionProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency } = useNumberFormat();

  if (!impact) return null;

  const formatMonth = (date: string | null) =>
    date ? formatChartDate(date, 'MMM yyyy') : t('loanDetail.pastImpact.unknown');

  const cards: SummaryCardItem[] = [
    {
      label: t('loanDetail.pastImpact.extraPrincipalPaid'),
      value: formatCurrency(impact.extraPrincipalPaid, account.currencyCode),
      valueClass: 'text-blue-600 dark:text-blue-400',
      note: t('loanDetail.pastImpact.extraPrincipalNote'),
    },
    {
      label: t('loanDetail.pastImpact.monthsAlreadySaved'),
      // Unknown when either payoff date is: "0 months" would tell the borrower
      // their overpayments bought no time.
      value:
        impact.monthsAlreadySaved == null
          ? t('loanDetail.pastImpact.unknown')
          : t('loanDetail.pastImpact.monthsValue', {
              count: impact.monthsAlreadySaved,
            }),
      valueClass: 'text-green-600 dark:text-green-400',
      note: t('loanDetail.pastImpact.payoffComparison', {
        original: formatMonth(impact.originalPayoffDate),
        current: formatMonth(impact.currentPayoffDate),
      }),
    },
    {
      label: t('loanDetail.pastImpact.interestAlreadySaved'),
      // Unknown when either schedule stopped at its projection horizon: the
      // difference of two horizons is not a saving.
      value:
        impact.interestAlreadySaved == null
          ? t('loanDetail.pastImpact.unknown')
          : formatCurrency(impact.interestAlreadySaved, account.currencyCode),
      valueClass: 'text-green-600 dark:text-green-400',
      note: impact.originalSchedule.paidOff
        ? t('loanDetail.pastImpact.vsOriginalInterest', {
            amount: formatCurrency(
              impact.originalSchedule.totalInterest,
              account.currencyCode,
            ),
          })
        : undefined,
    },
  ];

  return <SummaryCardGrid cards={cards} className="grid grid-cols-2 md:grid-cols-3 gap-4" />;
}
