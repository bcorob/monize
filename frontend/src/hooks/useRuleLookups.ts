'use client';

import { useCallback, useEffect, useState } from 'react';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { createLogger } from '@/lib/logger';
import { payeesApi } from '@/lib/payees';
import { tagsApi } from '@/lib/tags';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import type { Tag } from '@/types/tag';

const logger = createLogger('RuleLookups');

/** Everything a rule can name by id, so the editor never shows a raw id. */
export interface RuleLookups {
  /** Only the accounts the caller owns: a rule may not name a shared one. */
  readonly accounts: readonly Account[];
  /** Active and inactive: a stored rule may name a payee that was deactivated. */
  readonly payees: readonly Payee[];
  readonly categories: readonly Category[];
  readonly tags: readonly Tag[];
  /** The user's active currency codes. */
  readonly currencyCodes: readonly string[];
}

export type RuleLookupsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly lookups: RuleLookups };

/**
 * Loads the five lists the rule editor's pickers read. Any one failing is a
 * failure of the whole: a picker with one list missing would show a stored id
 * as a blank field, and the rule could be saved over it.
 */
export function useRuleLookups(): { state: RuleLookupsState; reload: () => void } {
  const [state, setState] = useState<RuleLookupsState>({ status: 'loading' });
  // Bumped by `reload`; each value is one request, and only the newest may answer.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      accountsApi.getAll(true),
      payeesApi.getAll('all'),
      categoriesApi.getAll(),
      tagsApi.getAll(),
      exchangeRatesApi.getCurrencies(),
    ])
      .then(([accounts, payees, categories, tags, currencies]) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          lookups: {
            accounts: accounts.filter((a) => !a.isJoint),
            payees,
            categories,
            tags,
            currencyCodes: currencies.filter((c) => c.isActive).map((c) => c.code),
          },
        });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
