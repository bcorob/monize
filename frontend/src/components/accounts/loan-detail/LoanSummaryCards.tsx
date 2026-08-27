'use client';

import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import {
  LoanScheduleResult,
  ScheduleFrequency,
  effectiveAnnualRate,
  getPeriodsPerYear,
} from '@/lib/loan-schedule';
import { deriveLoanFigures } from '@/lib/loan-figures';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import {
  SummaryCardGrid,
  SummaryCardItem,
  summaryGridClass,
} from '@/components/accounts/shared/SummaryCardGrid';

interface LoanSummaryCardsProps {
  account: Account;
  /** Original loan amount (opening balance or derived from history) */
  startingBalance: number;
  /**
   * The borrower's real current installment (principal + interest) derived from
   * the payment history. Preferred over the stored `paymentAmount`, which for
   * loans that book interest separately holds only the principal part.
   */
  currentInstallment: number | null;
  /** Projection from the current balance; null when the loan can't project */
  baseline: LoanScheduleResult | null;
}

/**
 * Key figures for the loan detail page: balance, original amount, rate,
 * payment, and the baseline projection's payoff date / remaining interest.
 */
export function LoanSummaryCards({
  account,
  startingBalance,
  currentInstallment,
  baseline,
}: LoanSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const currency = account.currencyCode;

  // The card is shown only for Canadian fixed-rate mortgages, where the
  // semi-annual compounding the law requires makes the effective rate differ
  // visibly from the quoted one -- and that branch is frequency-independent by
  // law, so calling the shared `effectiveAnnualRate` changes no displayed
  // number. It removes a third inline copy of the compounding convention
  // (INV-LOAN-003) and nothing else: a DRY change, not a behaviour fix. The
  // The frequency and both flags are passed rather than hardcoded, because they
  // are the correct arguments if this card ever shows a non-Canadian mortgage.
  // Hardcoding `true, false` beside a comment defending the frequency argument
  // was the worst of both: widen the guard and the call takes the semi-annual
  // branch for a US mortgage, on which the frequency is ignored anyway.
  const isCanadianFixed = account.isCanadianMortgage && !account.isVariableRate;
  const effectiveRate =
    // `!= null`, not truthiness: the card above prints `0%` from
    // `account.interestRate != null`, so suppressing the effective-rate note for
    // a 0% mortgage treated a known 0.000% as "could not be worked out".
    isCanadianFixed && account.interestRate != null
      ? effectiveAnnualRate(
          account.interestRate,
          getPeriodsPerYear((account.paymentFrequency ?? 'MONTHLY') as ScheduleFrequency),
          account.isCanadianMortgage ?? false,
          account.isVariableRate ?? false,
        )
      : null;

  const frequencyLabel = account.paymentFrequency
    ? t(`loanDetail.frequency.${account.paymentFrequency}` as Parameters<typeof t>[0])
    : null;

  // The stored paymentAmount is often principal-only (separately-booked
  // interest) and stale; prefer the real installment derived from history.
  // `deriveLoanFigures` decides when each figure is known -- the same decision
  // the transactions Details sidebar shows, made once so the two cannot drift.
  const figures = deriveLoanFigures({
    currentBalance: account.currentBalance,
    currentInstallment: currentInstallment ?? account.paymentAmount ?? null,
    baseline,
  });

  const payoffLabel = figures.payoffDate
    ? formatChartDate(figures.payoffDate, 'MMM yyyy')
    : null;

  const cards: SummaryCardItem[] = [
    {
      label: t('loanDetail.summary.currentBalance'),
      value: formatCurrency(Math.abs(account.currentBalance), currency),
      valueClass: 'text-red-600 dark:text-red-400',
    },
    {
      label: t('loanDetail.summary.originalAmount'),
      value: formatCurrency(startingBalance, currency),
    },
    {
      label: t('loanDetail.summary.interestRate'),
      value: account.interestRate != null ? `${account.interestRate}%` : t('loanDetail.summary.notSet'),
      note:
        effectiveRate != null
          ? t('loanDetail.summary.effectiveRate', { rate: effectiveRate.toFixed(3) })
          : undefined,
    },
    {
      label: t('loanDetail.summary.payment'),
      value:
        figures.currentPayment != null
          ? formatCurrency(figures.currentPayment, currency)
          : t('loanDetail.summary.notSet'),
      note: frequencyLabel ?? undefined,
    },
    {
      label: t('loanDetail.summary.estPayoff'),
      value: figures.isSettled
        ? t('loanDetail.summary.paidOff')
        : payoffLabel ?? t('loanDetail.summary.notAvailable'),
      valueClass: 'text-purple-600 dark:text-purple-400',
    },
    {
      label: t('loanDetail.summary.estRemainingInterest'),
      value:
        figures.remainingInterest != null
          ? formatCurrency(figures.remainingInterest, currency)
          : t('loanDetail.summary.notAvailable'),
      valueClass: 'text-orange-600 dark:text-orange-400',
    },
  ];

  return <SummaryCardGrid cards={cards} className={summaryGridClass(cards.length)} />;
}
