'use client';

import { useEffect, useRef, useState } from 'react';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import type { InvestmentRegisterFilterOptions } from '@/types/investment';

const logger = createLogger('BrokerageFilterOptions');

const NO_OPTIONS: InvestmentRegisterFilterOptions = { actions: [], symbols: [] };

/**
 * What a brokerage register can be narrowed by: the actions and symbols its own
 * rows use, fetched for the accounts on screen.
 *
 * The sibling of `useCashFilterOptions`
 * (`components/investments/CashRegisterFilters.tsx`), and for the same reason:
 * a picker offering the whole vocabulary to narrow six rows is a list to read
 * rather than a filter to use. The two registers of one account therefore ask
 * the same question of their own rows, each in its own terms.
 *
 * Empty arrays while it loads (and after a failure) are the right thing for
 * this one: the action picker falls back to the full vocabulary when it is
 * handed nothing, so a slow or failed lookup leaves it as it has always been
 * rather than emptying it. The failure does not latch -- the next change of
 * accounts asks again.
 */
export function useBrokerageFilterOptions(
  accountIds: string[],
): InvestmentRegisterFilterOptions {
  const [options, setOptions] = useState<InvestmentRegisterFilterOptions>(
    NO_OPTIONS,
  );
  // Which request the options on screen answered, so a re-render does not
  // re-ask and a changed account set does.
  const loadedKeyRef = useRef<string | null>(null);
  const key = [...accountIds].sort().join(',');

  useEffect(() => {
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    investmentsApi
      .getRegisterFilterOptions(accountIds)
      .then((next) => {
        // The ref, not a cleanup flag, decides whether this answer is still
        // the one being asked for. React's development StrictMode mounts,
        // unmounts and remounts, so a flag set in the cleanup discards the only
        // request that ever ran -- the second pass sees the key already claimed
        // and starts none -- and the picker sits empty for the whole session.
        // That is what left the Action picker offering the full vocabulary and
        // the payee picker reading "No options found" in dev.
        if (loadedKeyRef.current === key) setOptions(next);
      })
      .catch((error) => {
        logger.error('Failed to load brokerage filter options:', error);
        if (loadedKeyRef.current === key) loadedKeyRef.current = null;
      });
    // `accountIds` is a fresh array on every render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return options;
}
