'use client';

import { useEffect, useState } from 'react';
import { transactionsApi } from '@/lib/transactions';
import type { StaleUnreconciledSummary } from '@/types/transaction';

export interface StaleReconciliationContext {
  /** Last reconciled date per account, for accounts the user reconciles. */
  lastReconciledByAccount: Map<string, string>;
  /** The date the server chose as the overdue boundary. */
  overdueBefore: string;
}

/**
 * The context a register needs to mark rows overdue for reconciliation.
 *
 * Returns `undefined` until it is known, and stays `undefined` when the lookup
 * fails: a failed request is not "nothing is overdue", and a register that
 * silently stopped highlighting would be indistinguishable from a ledger that
 * is up to date. Every consumer treats `undefined` as "no information" and
 * marks no row, which is the honest reading of both states.
 *
 * The summary lists only accounts that currently *have* outstanding rows, so an
 * account absent from the map is one with nothing overdue -- which is exactly
 * how `classifyStaleRow` reads a missing entry.
 */
export function useStaleReconciliation(): StaleReconciliationContext | undefined {
  const [context, setContext] = useState<StaleReconciliationContext | undefined>(
    undefined,
  );

  // The state is written from the promise's own callbacks rather than from the
  // effect body: a synchronous setState in an effect is a cascading render (and
  // the `react-hooks/set-state-in-effect` rule), and this shape gives the
  // unmount guard somewhere to live as well.
  useEffect(() => {
    let cancelled = false;
    // `Promise.resolve().then(...)` rather than calling straight through: the
    // hook's contract is that no failure of this lookup can affect the page it
    // decorates, and a call that throws *synchronously* would escape a
    // `.catch()` attached to its result and take the render with it.
    Promise.resolve()
      .then(() => transactionsApi.getStaleUnreconciled())
      .then((summary: StaleUnreconciledSummary) => {
        if (cancelled) return;
        setContext({
          lastReconciledByAccount: new Map(
            summary.accounts.map((account) => [
              account.accountId,
              account.lastReconciledDate,
            ]),
          ),
          overdueBefore: summary.overdueBefore,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setContext(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return context;
}
