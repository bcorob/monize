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
import { compoundingFor, mortgageTypeOf } from '@/lib/mortgage-type';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
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
  /**
   * The due date `currentInstallment` is for, on a LINEAR or INTEREST_ONLY
   * mortgage whose installment changes from one due date to the next
   * (`CurrentLoanTerms.paymentDate`); null for an annuity's constant payment.
   */
  currentInstallmentDate?: string | null;
  /** An INTEREST_ONLY mortgage's bullet (`CurrentLoanTerms.finalPayment`). */
  finalPayment?: { amount: number; date: string } | null;
  /**
   * The rate in effect, resolved from the rate history the projection also uses
   * (`resolveCurrentLoanTerms`) -- NOT `account.interestRate`, which recording a
   * rate change deliberately never writes and which is therefore the OLD rate on
   * any loan whose rate was changed through the rate-history UI. Showing the
   * scalar here put "5%" on the card beside a payoff the projection had refused
   * at the real 12%.
   */
  currentAnnualRate: number | null;
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
  currentInstallmentDate = null,
  finalPayment = null,
  currentAnnualRate,
  baseline,
}: LoanSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { formatDate } = useDateFormat();
  const currency = account.currencyCode;

  // The card is shown only for a semi-annually compounded mortgage
  // (`CANADIAN_FIXED`), where the compounding the law requires makes the
  // effective rate differ visibly from the quoted one -- and that branch is
  // frequency-independent by law, so calling the shared `effectiveAnnualRate`
  // changes no displayed number. It removes a third inline copy of the
  // compounding convention (INV-LOAN-003) and nothing else. The frequency and
  // the type are passed rather than hardcoded, because they are the correct
  // arguments if this card ever shows a mortgage of another compounding.
  const mortgageType = mortgageTypeOf(account);
  const isSemiAnnual = compoundingFor(mortgageType) === 'SEMI_ANNUAL';
  // Both halves of this line were changed independently and both are needed.
  // From upstream: derive through the shared `effectiveAnnualRate` rather than a
  // third inline copy of the compounding convention (INV-LOAN-003), and test
  // `!= null` rather than truthiness so a known 0.000% is not reported as
  // "could not be worked out". From this branch: the rate is the RESOLVED one,
  // not `account.interestRate` -- the scalar a rate-change mutation deliberately
  // never writes, so on any loan whose rate was changed through the rate-history
  // UI it is the old rate, and the note would compound a rate nobody pays. The
  // card's own value directly below reads `currentAnnualRate`, so taking the
  // scalar here would also make the headline and its note disagree.
  const effectiveRate =
    isSemiAnnual && currentAnnualRate != null
      ? effectiveAnnualRate(
          currentAnnualRate,
          getPeriodsPerYear((account.paymentFrequency ?? 'MONTHLY') as ScheduleFrequency),
          mortgageType,
        )
      : null;

  const frequencyLabel = account.paymentFrequency
    ? t(`loanDetail.frequency.${account.paymentFrequency}` as Parameters<typeof t>[0])
    : null;

  // No `?? account.paymentAmount` here any more, and its absence is the point:
  // `resolveCurrentLoanTerms` -- which produced `currentInstallment` -- already
  // ranks that scalar as its last candidate, so a fallback to it here was a
  // SECOND place the payment gets decided. Provably a no-op today (the resolver
  // returns null only when the scalar is itself absent or non-positive, and
  // `deriveLoanFigures` maps a non-positive installment to null regardless), but
  // one decision in one place is the rule this work exists to establish, and a
  // redundant fallback reads as a policy the card is entitled to have.
  //
  // `deriveLoanFigures` decides when each figure is known -- the same decision
  // the transactions Details sidebar shows, made once so the two cannot drift.
  const figures = deriveLoanFigures({
    currentBalance: account.currentBalance,
    currentInstallment,
    currentInstallmentDate,
    finalPayment,
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
      value:
        currentAnnualRate != null
          ? `${formatPercentTrimmed(currentAnnualRate)}`
          : t('loanDetail.summary.notSet'),
      note:
        effectiveRate != null
          ? t('loanDetail.summary.effectiveRate', { rate: effectiveRate.toFixed(3) })
          : undefined,
    },
    // A LINEAR or INTEREST_ONLY installment changes from one due date to the
    // next, so it is captioned as the next one and dated rather than shown as
    // a constant "Payment" (docs/specs/mortgage-types.md, section 5.6).
    figures.currentPaymentDate != null
      ? {
          label: t('loanDetail.summary.nextInstallment'),
          value:
            figures.currentPayment != null
              ? formatCurrency(figures.currentPayment, currency)
              : t('loanDetail.summary.notSet'),
          note: t('loanDetail.summary.dueOn', {
            date: formatDate(figures.currentPaymentDate),
          }),
        }
      : {
          label: t('loanDetail.summary.payment'),
          value:
            figures.currentPayment != null
              ? formatCurrency(figures.currentPayment, currency)
              : t('loanDetail.summary.notSet'),
          note: frequencyLabel ?? undefined,
        },
    // The bullet beside an interest-only installment, which otherwise
    // understates what is owed by the whole principal.
    ...(figures.finalPayment != null
      ? [
          {
            label: t('loanDetail.summary.finalPayment'),
            value: formatCurrency(figures.finalPayment.amount, currency),
            note: t('loanDetail.summary.dueOn', {
              date: formatDate(figures.finalPayment.date),
            }),
          },
        ]
      : []),
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
