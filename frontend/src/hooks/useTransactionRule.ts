'use client';

import { useCallback, useEffect, useState } from 'react';
import { AxiosError } from 'axios';
import { createLogger } from '@/lib/logger';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { TransactionRule } from '@/types/transaction-rule';

const logger = createLogger('TransactionRule');

export type TransactionRuleLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly notFound: boolean }
  /** `rule` is null for a new rule, which has nothing to load. */
  | { readonly status: 'ready'; readonly rule: TransactionRule | null };

/**
 * Loads one rule for the editor. A failed load is its own state, never an
 * empty rule: the editor would otherwise offer a blank form over a rule that
 * exists, and saving it would overwrite the stored one.
 *
 * The hook belongs to one rule id: a page that can show another id mounts it
 * again (`key`), so a late answer for the old id has nowhere to land.
 */
export function useTransactionRule(ruleId: string | undefined): {
  state: TransactionRuleLoad;
  reload: () => void;
  adopt: (rule: TransactionRule) => void;
} {
  const [state, setState] = useState<TransactionRuleLoad>(
    ruleId === undefined ? { status: 'ready', rule: null } : { status: 'loading' },
  );
  // Bumped by `reload`; each value is one request, and only the newest may answer.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (ruleId === undefined) return;
    let cancelled = false;
    transactionRulesApi
      .getById(ruleId)
      .then((rule) => {
        if (!cancelled) setState({ status: 'ready', rule });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({
          status: 'error',
          notFound: error instanceof AxiosError && error.response?.status === 404,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ruleId, attempt]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const adopt = useCallback((rule: TransactionRule) => {
    setState({ status: 'ready', rule });
  }, []);

  return { state, reload, adopt };
}
