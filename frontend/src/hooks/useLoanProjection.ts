'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  fetchAllAccountTransactions,
  fetchLoanInterestTransactions,
  resolveCurrentLoanTerms,
} from '@/lib/loan-history';
import {
  loanRateChangesApi,
  RATE_CHANGE_ACCOUNT_TYPES,
} from '@/lib/loan-rate-changes';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { deriveLoanFigures, type LoanFigures } from '@/lib/loan-figures';
import { createLogger } from '@/lib/logger';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import type { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanRateChange } from '@/types/loan-rate-change';

const logger = createLogger('useLoanProjection');

/**
 * The account types this projection describes: amortizing debt.
 *
 * Derived from the rate-changes precondition rather than spelled again -- and
 * this hook is why the derivation matters, not merely why it is tidy. It
 * fetches `loanRateChangesApi.getAll` unconditionally for every type in here,
 * so a type present in this set but absent from `RATE_CHANGE_ACCOUNT_TYPES`
 * would take a **400** on every load and report the projection as `error`. The
 * two lists coincide for one reason: a revolving line does not amortize, which
 * is the same fact that leaves it no contractual rate to change.
 */
const AMORTIZING_DEBT_TYPES: ReadonlySet<Account['accountType']> = new Set(
  RATE_CHANGE_ACCOUNT_TYPES,
);

export type LoanProjectionStatus =
  /** Not an amortizing debt account -- there is nothing to project. */
  | 'idle'
  /** The history this projection is built from is still loading. */
  | 'loading'
  /** The history could not be loaded; the figures are unknown, not empty. */
  | 'error'
  | 'ready';

export interface LoanProjectionResult extends LoanFigures {
  status: LoanProjectionStatus;
  /**
   * The annual rate in effect, from the same resolution the payoff is projected
   * at -- `account.interestRate` is the OLD rate on any loan whose rate was
   * changed through the rate-history UI. Null while loading or unknown, so a
   * consumer keeps its own fallback for those states.
   */
  currentAnnualRate: number | null;
}

/** The raw history one account's projection is derived from, with its own key. */
interface LoanSourceData {
  /** The account the payload answers for -- a late response for another is dropped. */
  accountId: string;
  transactions: Transaction[];
  interestTransactions: Transaction[];
  rateChanges: LoanRateChange[];
}

/**
 * The current payment, estimated payoff date and estimated remaining interest
 * for a loan or mortgage account, derived the same way the loan detail page
 * derives them: the account's full payment history, its separately booked
 * interest and its recorded rate changes feed `deriveLoanPaymentHistory`, and
 * the no-overpayment baseline projection continues from today's balance.
 *
 * Nothing is fetched for an account type that does not amortize; the status is
 * `idle` and every figure is absent, which is "not applicable" rather than
 * "unknown". A failed load is `error` with the figures unknown -- never an empty
 * history, which would project a plausible payoff from no payments at all.
 */
export function useLoanProjection(account: Account, refreshKey = 0): LoanProjectionResult {
  const isAmortizingDebt = AMORTIZING_DEBT_TYPES.has(account.accountType);
  const accountId = account.id;

  // Both are stamped with the account they answer for, so a payload or a failure
  // left over from the previously selected account reads as "still loading"
  // rather than as this account's answer. Nothing is cleared on switching --
  // the key comparison below is what decides, not the order of two setStates.
  // Switching is not the only way a failure stops being true, though: a later
  // load of the *same* account succeeding retires it (see the load below), or
  // one transient outage would leave the figures unavailable for the rest of the
  // page's life.
  const [data, setData] = useState<LoanSourceData | null>(null);
  const [failedAccountId, setFailedAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAmortizingDebt) return;
    let cancelled = false;
    const load = async () => {
      try {
        // The interest fetch needs the loan's configured interest category and
        // source account, so it takes the account rather than just its id.
        const [transactions, interestTransactions, rateChanges] = await Promise.all([
          fetchAllAccountTransactions(accountId),
          fetchLoanInterestTransactions(account),
          loanRateChangesApi.getAll(accountId),
        ]);
        if (cancelled) return;
        setData({ accountId, transactions, interestTransactions, rateChanges });
        // A success retires this account's earlier failure, and only this
        // account's: the failure describes a request that has now been answered,
        // so leaving it set outranks fresh data with a stale error and no
        // in-page refresh can recover the figures. Compared inside the updater
        // rather than against the render's `failedAccountId`, so a failure
        // recorded for a *different* account while this load was in flight
        // survives.
        setFailedAccountId((failed) => (failed === accountId ? null : failed));
      } catch (error) {
        if (cancelled) return;
        // A rate-history or payment-history failure changes what the projection
        // would say, so it is reported as unknown rather than projected from
        // whatever did load.
        logger.error('Failed to load loan history:', error);
        setFailedAccountId(accountId);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // `account` is only read for its interest-category / source-account fields,
    // which the account edit form reloads the page's list on changing; keying
    // the fetch on the id alone keeps a re-rendered account object from
    // refetching the whole history on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAmortizingDebt, refreshKey]);

  // Today-anchored (see `loan-projection-anchor.guard.test.ts`) still has to
  // say WHICH today: the rate in effect and the date row 1 falls on are both
  // calendar-day answers, and this hook's payoff date is quoted beside the
  // amortization report's schedule.
  const todayYmd = useFinancialToday();

  return useMemo<LoanProjectionResult>(() => {
    const unknown: LoanFigures = {
      isSettled: false,
      currentPayment: null,
      payoffDate: null,
      remainingInterest: null,
    };
    if (!isAmortizingDebt) return { status: 'idle', currentAnnualRate: null, ...unknown };
    if (failedAccountId === accountId) {
      // The balance is the account's own, so a settled debt still reads as
      // settled even when its history could not be loaded.
      return {
        status: 'error',
        currentAnnualRate: null,
        ...unknown,
        ...deriveLoanFigures({
          currentBalance: account.currentBalance,
          currentInstallment: null,
          baseline: null,
        }),
      };
    }
    if (!data || data.accountId !== accountId)
      return { status: 'loading', currentAnnualRate: null, ...unknown };

    const history = deriveLoanPaymentHistory(
      account,
      data.transactions,
      data.rateChanges,
      data.interestTransactions,
    );
    const currentTerms = resolveCurrentLoanTerms(
      account,
      history,
      data.rateChanges,
      null,
      todayYmd,
    );
    const projectionInput = buildLoanProjectionInput(
      account,
      history,
      data.rateChanges,
      null,
      todayYmd,
    );
    const baseline = projectionInput ? generateLoanSchedule(projectionInput) : null;

    return {
      status: 'ready',
      currentAnnualRate: currentTerms.annualRate,
      ...deriveLoanFigures({
        currentBalance: account.currentBalance,
        currentInstallment: currentTerms.payment,
        baseline,
      }),
    };
  }, [account, accountId, data, failedAccountId, isAmortizingDebt, todayYmd]);
}
