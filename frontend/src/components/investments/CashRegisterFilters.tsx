'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { DateInput } from '@/components/ui/DateInput';
import { transactionsApi } from '@/lib/transactions';
import { createLogger } from '@/lib/logger';
import type { RegisterFilterOptions } from '@/types/transaction';

const logger = createLogger('CashRegisterFilters');

const NO_OPTIONS: RegisterFilterOptions = { payees: [], categories: [] };

/**
 * The payees and categories a cash register can be narrowed by: the ones its
 * own rows use, fetched when the register is on screen.
 *
 * Both halves of this were wrong before. The Investments page loaded the
 * options only when the user *clicked* through to the cash view, so landing on
 * the remembered cash view left both pickers reading "No options found" -- the
 * one path nobody takes while developing. And it asked for every payee and
 * category in the ledger, which is not a way through a brokerage cash
 * register's dozen rows.
 *
 * A failed lookup leaves the previous options standing rather than claiming
 * there is nothing to filter by, and does not latch: the next time the
 * register comes back on screen, or the account set changes, it asks again.
 */
export function useCashFilterOptions(
  enabled: boolean,
  accountIds: string[],
): RegisterFilterOptions {
  const [options, setOptions] = useState<RegisterFilterOptions>(NO_OPTIONS);
  // Which request the options on screen answered, so a re-render does not
  // re-ask and a changed account set does.
  const loadedKeyRef = useRef<string | null>(null);
  const key = [...accountIds].sort().join(',');

  useEffect(() => {
    if (!enabled || loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    transactionsApi
      .getRegisterFilterOptions(accountIds)
      .then((next) => {
        // The ref decides whether this answer is still the one being asked
        // for -- a cleanup flag cannot, because React's development StrictMode
        // mounts, unmounts and remounts, so the flag discards the only request
        // that ever ran and the pickers stay empty for the session.
        if (loadedKeyRef.current === key) setOptions(next);
      })
      .catch((error) => {
        logger.error('Failed to load cash filter options:', error);
        // Not an empty ledger: let the next attempt through.
        if (loadedKeyRef.current === key) loadedKeyRef.current = null;
      });
    // `accountIds` is a fresh array on every render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return options;
}

/**
 * What a cash register can be narrowed by: who, what for, and when.
 *
 * One object rather than four loose values, because every caller sets them
 * together, counts them together and clears them together -- and a register
 * that reloads on a filter change has to be able to ask "did this change?" of
 * one thing.
 */
export interface CashFilterValues {
  payeeIds: string[];
  categoryIds: string[];
  startDate: string;
  endDate: string;
}

export const EMPTY_CASH_FILTERS: CashFilterValues = {
  payeeIds: [],
  categoryIds: [],
  startDate: '',
  endDate: '',
};

/** How many of the four are narrowing the list -- the number on the badge. */
export function countActiveCashFilters(value: CashFilterValues): number {
  return (
    (value.payeeIds.length > 0 ? 1 : 0) +
    (value.categoryIds.length > 0 ? 1 : 0) +
    (value.startDate ? 1 : 0) +
    (value.endDate ? 1 : 0)
  );
}

interface CashFilterToggleButtonProps {
  activeCount: number;
  onClick: () => void;
}

/**
 * The button that opens the bar, with the count of what is already applied.
 *
 * It is here rather than in the bar because it belongs to the register's
 * heading row, beside "New Cash Transaction", while the bar drops below it.
 */
export function CashFilterToggleButton({
  activeCount,
  onClick,
}: CashFilterToggleButtonProps) {
  const t = useTranslations('investments');
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md ${
        activeCount > 0
          ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
      </svg>
      {t('page.filter')}
      {activeCount > 0 && (
        <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">
          {activeCount}
        </span>
      )}
    </button>
  );
}

interface CashFilterBarProps {
  /** What the pickers offer -- see {@link useCashFilterOptions}. */
  options: RegisterFilterOptions;
  value: CashFilterValues;
  onChange: (next: CashFilterValues) => void;
}

/**
 * The cash register's filter bar, drawn the same way wherever a cash register
 * is drawn: the Investments page's cash view and the investment account detail
 * page's, which are the same register under two headings.
 *
 * It is one component for the reason the brokerage list's own filter row is
 * part of that list -- a second copy is how two views of one account come to
 * offer different ways to narrow the same rows. Its strings stay in the
 * `investments` namespace's `page.*` keys, which is where they were written and
 * translated; moving them would retranslate twenty locales to say the same
 * thing.
 *
 * Controlled: the values and the open/closed state belong to the surface, which
 * is also what reloads when they change.
 */
export function CashFilterBar({
  options,
  value,
  onChange,
}: CashFilterBarProps) {
  const t = useTranslations('investments');
  const { payees, categories } = options;

  const categoryOptions = useMemo((): MultiSelectOption[] => {
    const buildOptions = (parentId: string | null = null): MultiSelectOption[] =>
      categories
        .filter((c) => c.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((cat) => {
          const children = buildOptions(cat.id);
          return [{
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          }];
        });
    return buildOptions();
  }, [categories]);

  const payeeOptions = useMemo((): MultiSelectOption[] => {
    // sort() mutates, so sort a copy: the caller's list is not this bar's to
    // reorder.
    return [...payees]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((payee) => ({ value: payee.id, label: payee.name }));
  }, [payees]);

  const activeCount = countActiveCashFilters(value);

  return (
    <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MultiSelect
          label={t('page.cashFilterPayees')}
          options={payeeOptions}
          value={value.payeeIds}
          onChange={(payeeIds) => onChange({ ...value, payeeIds })}
          placeholder={t('page.allPayees')}
        />
        <MultiSelect
          label={t('page.cashFilterCategories')}
          options={categoryOptions}
          value={value.categoryIds}
          onChange={(categoryIds) => onChange({ ...value, categoryIds })}
          placeholder={t('page.allCategories')}
        />
        {/* `onDateChange` alone: it emits an ISO date, while a raw `onChange`
            beside it reports whatever is typed and so ignores the user's date
            format (#1201). */}
        <DateInput
          label={t('page.cashFilterFrom')}
          value={value.startDate}
          onDateChange={(startDate) => onChange({ ...value, startDate })}
        />
        <DateInput
          label={t('page.cashFilterTo')}
          value={value.endDate}
          onDateChange={(endDate) => onChange({ ...value, endDate })}
        />
      </div>
      {activeCount > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => onChange(EMPTY_CASH_FILTERS)}
            className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
          >
            {t('page.clearFilters')}
          </button>
        </div>
      )}
    </div>
  );
}
