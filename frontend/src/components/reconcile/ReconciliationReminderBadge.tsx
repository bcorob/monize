'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useDateFormat } from '@/hooks/useDateFormat';
import { transactionsApi } from '@/lib/transactions';
import { subscribeReconciliation } from '@/lib/reconciliationSignal';
import type { StaleUnreconciledSummary } from '@/types/transaction';

/**
 * The persistent top-level reminder for reconciliation, beside the budget
 * alerts it is modelled on.
 *
 * An overdue bill gets a standing reminder because the consequence of missing
 * it compounds quietly; a transaction the bank has settled and the ledger has
 * not is the same shape of problem, and by the time the next statement arrives
 * the difference is two statements wide. So this is deliberately **not
 * dismissible**: there is no per-row state to clear, and the count goes to zero
 * by reconciling, which is the action the reminder is asking for.
 *
 * It renders nothing at all for a user who does not reconcile -- the server
 * only counts accounts with a reconciled transaction in them -- so nobody who
 * has not opted into reconciliation ever sees a badge about it.
 *
 * A failed load is not an empty summary: `summary` stays null and the badge
 * stays hidden rather than claiming everything is up to date.
 */
export function ReconciliationReminderBadge() {
  const t = useTranslations('reconcile');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const [summary, setSummary] = useState<StaleUnreconciledSummary | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Written from the promise's callbacks, not the effect body, so the state
  // update is not a synchronous cascading render (`react-hooks/set-state-in-effect`).
  //
  // `reloadToken` re-runs it. The badge lives in the header and so is never
  // remounted by navigating: without a re-fetch, finishing the reconciliation
  // it asked for would leave its own count on screen.
  useEffect(() => {
    let cancelled = false;
    // Deferred with Promise.resolve() for the same reason as
    // `useStaleReconciliation`: a synchronous throw must leave the header
    // standing, not unmount it.
    Promise.resolve()
      .then(() => transactionsApi.getStaleUnreconciled())
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        // A failed lookup is not "nothing outstanding": leave the badge hidden
        // rather than reporting an outage as a clean bill of health.
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(
    () => subscribeReconciliation(() => setReloadToken((token) => token + 1)),
    [],
  );

  useClickOutside(dropdownRef, () => setIsOpen(false));

  const totalCount = summary?.totalCount ?? 0;
  if (!summary || totalCount === 0) return null;

  const openAccount = (accountId: string) => {
    setIsOpen(false);
    router.push(`/reconcile?accountId=${accountId}`);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
        title={t('reminder.title')}
        aria-label={t('reminder.badgeLabel', { count: totalCount })}
        data-testid="reconcile-reminder-button"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
          />
        </svg>
        <span
          className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-amber-500 rounded-full"
          data-testid="reconcile-reminder-count"
        >
          {totalCount > 9 ? '9+' : totalCount}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('reminder.title')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('reminder.badgeLabel', { count: totalCount })}
            </p>
          </div>
          <ul className="scrollbar-slim max-h-80 overflow-y-auto pr-1 divide-y divide-gray-200 dark:divide-gray-700">
            {summary.accounts.map((account) => (
              <li key={account.accountId} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {account.accountName}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('reminder.accountLine', {
                        count: account.count,
                        date: formatDate(account.oldestDate),
                      })}
                    </p>
                    {account.missedCount > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t('reminder.missedLine', { count: account.missedCount })}
                      </p>
                    )}
                    {account.overdueCount > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t('reminder.overdueLine', {
                          count: account.overdueCount,
                          days: summary.staleAfterDays,
                        })}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openAccount(account.accountId)}
                    className="shrink-0 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('reminder.reconcileAction')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
