'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  EMPTY_RECEIPT_SEARCH_INPUT,
  isReceiptRangeBackwards,
  isReceiptSearchActive,
  normalizeReceiptSearch,
  readReceiptSearchInput,
  receiptSearchKey,
  writeReceiptSearchParams,
  type ReceiptSearchInput,
} from '@/lib/receipt-search';
import type { EmailReceiptSearch } from '@/types/email-receipts';

/** How long the text rests before it becomes a request; the other fields apply at once. */
export const RECEIPT_SEARCH_DEBOUNCE_MS = 300;

/**
 * The receipts list's search: what the bar shows (`input`, changes at once) and
 * what the list asks the server (`search`, the same after the text has rested).
 * Both start from `?q=`, `?in=`, `?from=` and `?to=` and the applied search is
 * written back to them (replace, like `?domain=`). `key` names the applied
 * search for request keys. Emptying the text applies at once, not after the delay.
 */
export function useReceiptSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [input, setInput] = useState<ReceiptSearchInput>(() => readReceiptSearchInput(searchParams));
  const restedText = useDebouncedValue(input.text, RECEIPT_SEARCH_DEBOUNCE_MS);
  const appliedText = input.text === '' ? '' : restedText;

  const normalized = normalizeReceiptSearch({ ...input, text: appliedText });
  // Primitive dependencies: the object stays the same one while the applied search does.
  const { search: query, searchIn, dateFrom, dateTo } = normalized;
  const search = useMemo<EmailReceiptSearch>(
    () => ({
      ...(query === undefined ? {} : { search: query }),
      ...(searchIn === undefined ? {} : { searchIn }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    }),
    [query, searchIn, dateFrom, dateTo],
  );
  const key = receiptSearchKey(search);

  // Write the applied search to the URL; nothing is written while the URL already says it.
  useEffect(() => {
    const next = writeReceiptSearchParams(searchParams, search);
    if (next.toString() === searchParams.toString()) return;
    // The tab is named so a link without a domain does not fall back to the Overview.
    next.set('tab', 'emails');
    const target = next.toString();
    router.replace(target === '' ? pathname : `${pathname}?${target}`, { scroll: false });
  }, [search, searchParams, router, pathname]);

  const change = useCallback((patch: Partial<ReceiptSearchInput>) => setInput((previous) => ({ ...previous, ...patch })), []);
  const clear = useCallback(() => setInput(EMPTY_RECEIPT_SEARCH_INPUT), []);

  return {
    input,
    change,
    clear,
    search,
    key,
    active: isReceiptSearchActive(search),
    /** Anything typed or chosen, applied or not: what the clear button acts on. */
    hasInput:
      input.text !== '' || input.searchIn !== 'all' || input.dateFrom !== '' || input.dateTo !== '',
    rangeBackwards: isReceiptRangeBackwards(input),
  };
}
