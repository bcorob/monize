'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { Input } from '@/components/ui/Input';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { shiftDate } from '@/lib/calendar-month';
import { createLogger } from '@/lib/logger';
import { transactionsApi } from '@/lib/transactions';
import type { Transaction } from '@/types/transaction';

const logger = createLogger('ReceiptTransactionPicker');

/** The matcher's own window around the purchase day (`match-receipt.ts`): the default range. */
export const RECEIPT_PICK_DAYS_BEFORE = 3;
export const RECEIPT_PICK_DAYS_AFTER = 14;
/** One bounded page; a longer list is narrowed with the search box, not paged. */
export const RECEIPT_PICK_PAGE_SIZE = 50;
/** How long the typed search rests before it becomes a request. */
export const RECEIPT_PICK_SEARCH_DEBOUNCE_MS = 300;

/** What one request asked for, and what it answered: `rows === null` is a request that failed. */
interface Answer {
  key: string;
  rows: Transaction[] | null;
  hasMore: boolean;
}

interface ReceiptTransactionPickerProps {
  /**
   * The email's `effectiveDate` (an ISO timestamp): the day the shop sent the
   * order when a forward carried it, else the day the email arrived. Its UTC day
   * is the matcher's purchase date and centres the DEFAULT range.
   */
  effectiveDate: string;
  /** The transaction being linked right now, if any; every Link button waits while one is. */
  linkingId: string | null;
  onLink: (transactionId: string) => void;
  /**
   * `link` (the default) is the detail dialog's "choose the transaction this
   * email paid for". `ai` is "Recognize with AI": the same list, the same
   * exclusions, but the choice is handed to the AI rather than stored as a
   * link, and the copy says so. `sample` is the profile wizard's "the transaction
   * this email paid for": kept in the wizard, written nowhere.
   */
  mode?: 'link' | 'ai' | 'sample';
  /** Called with the chosen row just before `onLink`, for a caller that shows what was chosen (the profile wizard). */
  onChoose?: (transaction: Transaction) => void;
  /** Text the search box starts with, and the first request uses (the profile wizard passes its domain). The person can edit it. */
  initialSearch?: string;
}

/**
 * "Choose transaction": the user's transactions in a date range, for an email the
 * matcher could not tie to one. The range starts as the window the matcher
 * searches (3 days before the purchase day to 14 after) and the From and To dates
 * are the person's to change, because the bank may have posted the charge well
 * outside it; the server accepts any of the user's linkable transactions whatever
 * its date. Optional text search narrows the page as the person types (debounced).
 *
 * The list belongs to the request that produced it (`Answer.key`): a slow answer
 * for an earlier range or search is never drawn under a newer one, and while the
 * new one loads the old rows are not offered. A transfer or a voided transaction
 * is not offered at all, since the server refuses to link either; a failed read is
 * an error, never "no transactions". A range whose From is after its To asks
 * nothing and says so.
 *
 * The default window is calendar arithmetic on the `YYYY-MM-DD` day
 * (`shiftDate`), never a `Date` built from it.
 */
export function ReceiptTransactionPicker({
  effectiveDate,
  linkingId,
  onLink,
  mode = 'link',
  onChoose,
  initialSearch = '',
}: ReceiptTransactionPickerProps) {
  const t = useTranslations('emailReceipts.picker');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const purchaseDate = effectiveDate.slice(0, 10);
  // The range is the person's to edit; it starts as the matcher's window. A
  // cleared or half-typed date is '' and asks nothing until it is a date again.
  const [from, setFrom] = useState(() => shiftDate(purchaseDate, -RECEIPT_PICK_DAYS_BEFORE));
  const [to, setTo] = useState(() => shiftDate(purchaseDate, RECEIPT_PICK_DAYS_AFTER));
  const rangeReady = from !== '' && to !== '' && from <= to;
  const rangeReversed = from !== '' && to !== '' && from > to;

  const [draft, setDraft] = useState(initialSearch);
  // The list follows the box as the person types, once the text has rested: each search is a server round trip.
  const typed = draft.trim();
  const restedSearch = useDebouncedValue(typed, RECEIPT_PICK_SEARCH_DEBOUNCE_MS);
  // The search the list is asked for. Emptying the box applies at once, not
  // after the delay; any other text applies only once the rested value IS the
  // box's text, so a value that rested before the box was emptied is never
  // asked for again while the next word is being typed. Adjusted during
  // render (no setState in an effect).
  const [search, setSearch] = useState(typed);
  if (typed === '' && search !== '') {
    setSearch('');
  } else if (typed !== '' && restedSearch === typed && search !== typed) {
    setSearch(typed);
  }
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);

  const key = `${from}|${to}|${search}|${attempt}`;

  useEffect(() => {
    if (!rangeReady) return;
    let cancelled = false;
    transactionsApi
      .getAll({
        startDate: from,
        endDate: to,
        limit: RECEIPT_PICK_PAGE_SIZE,
        ...(search !== '' ? { search } : {}),
      })
      .then((page) => {
        if (!cancelled) setAnswer({ key, rows: page.data, hasMore: page.pagination.hasMore });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setAnswer({ key, rows: null, hasMore: false });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, search, key, rangeReady]);

  const current = rangeReady && answer !== null && answer.key === key ? answer : null;
  const linkable = useMemo(
    () => (current?.rows ?? []).filter((row) => !row.isTransfer && !row.isVoid),
    [current],
  );

  return (
    <section aria-labelledby="receipt-picker-heading" className="space-y-2">
      <h3 id="receipt-picker-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t(mode === 'link' ? 'heading' : `${mode}.heading`)}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t(mode === 'link' ? 'help' : `${mode}.help`)}</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DateInput
          id="receipt-picker-from"
          label={t('fromLabel')}
          value={from}
          onDateChange={(date) => setFrom(date)}
        />
        <DateInput
          id="receipt-picker-to"
          label={t('toLabel')}
          value={to}
          onDateChange={(date) => setTo(date)}
        />
      </div>

      <Input
        id="receipt-picker-search"
        type="search"
        aria-label={t('searchPlaceholder')}
        value={draft}
        maxLength={200}
        autoComplete="off"
        placeholder={t('searchPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
      />

      {rangeReversed ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('rangeReversed')}
        </p>
      ) : !rangeReady ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('rangeIncomplete')}</p>
      ) : current === null ? (
        <LoadingSpinner text={t('loading')} />
      ) : current.rows === null ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">{t('error')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('retry')}
          </Button>
        </div>
      ) : linkable.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{search === '' ? t('empty') : t('emptySearch')}</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {linkable.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {t('row', {
                      date: formatDate(row.transactionDate),
                      amount: formatCurrency(Number(row.amount), row.currencyCode),
                      payee: row.payeeName ?? t('noPayee'),
                    })}
                  </div>
                  {row.description && (
                    <div className="break-words text-gray-500 dark:text-gray-400">
                      <LinkifiedText text={row.description} />
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  isLoading={linkingId === row.id}
                  disabled={linkingId !== null}
                  onClick={() => {
                    onChoose?.(row);
                    onLink(row.id);
                  }}
                >
                  {t(mode === 'link' ? 'linkButton' : `${mode}.linkButton`)}
                </Button>
              </li>
            ))}
          </ul>
          {current.hasMore && <p className="text-xs text-gray-500 dark:text-gray-400">{t('hasMore', { count: RECEIPT_PICK_PAGE_SIZE })}</p>}
        </>
      )}
    </section>
  );
}
