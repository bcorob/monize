'use client';

import { useEffect, useState } from 'react';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import type { EditorAction } from '@/lib/rule-actions';
import { createLogger } from '@/lib/logger';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';

const logger = createLogger('RuleEditor');

/** The linked bill of the loan a settlement action names, or null when the draft has none. */
export function settlementScheduleId(actions: readonly EditorAction[], lookups: RuleLookups): string | null {
  const settle = actions.find((action) => action.type === 'settle_loan_installment');
  if (settle === undefined || settle.type !== 'settle_loan_installment' || settle.loanAccountId === '') return null;
  return lookups.accounts.find((account) => account.id === settle.loanAccountId)?.scheduledTransactionId ?? null;
}

/**
 * Whether the loan's linked bill posts itself (`autoPost`): then the bill and
 * a settled bank debit would both pay the same installment, so the editor
 * warns. Fetched only while a settlement names a loan with a bill; the answer
 * is kept with the id it was asked for, so a stale answer never warns about
 * another loan, and a failed lookup does not warn (unknown, not "off").
 */
export function useLoanBillAutoPost(scheduleId: string | null): boolean {
  const [answer, setAnswer] = useState<{ id: string; autoPost: boolean } | null>(null);
  useEffect(() => {
    if (scheduleId === null) return;
    let live = true;
    scheduledTransactionsApi
      .getById(scheduleId)
      .then((bill) => {
        if (live) setAnswer({ id: scheduleId, autoPost: bill.autoPost });
      })
      .catch((error: unknown) => {
        logger.warn('The loan bill could not be loaded', error);
      });
    return () => {
      live = false;
    };
  }, [scheduleId]);
  return answer !== null && answer.id === scheduleId && answer.autoPost;
}
