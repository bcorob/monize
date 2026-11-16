'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyAiAction } from '@/lib/aiActionSignal';
import { clearAllCache } from '@/lib/apiCache';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptProcessableStatus, EmailReceiptStatus } from '@/types/email-receipts';

const logger = createLogger('ProcessStoredEmails');

/** What a run has done so far, summed over every call and every sender domain it covered. */
export interface ProcessTotals {
  processed: number;
  /** Emails that raised an error and were passed over. */
  failed: number;
  byOutcome: Partial<Record<EmailReceiptStatus, number>>;
  /** Processed emails their profile deleted: they have no status to end in. */
  deleted: number;
}

export type ProcessRunState =
  | { status: 'idle' }
  /** `remaining` is what is left of the sender domain being processed; unknown until its first answer. */
  | { status: 'running'; totals: ProcessTotals; remaining: number | null; cancelling: boolean }
  | { status: 'done'; totals: ProcessTotals; cancelled: boolean }
  /** A call failed: what had been done stays done, and the reason is the server's. */
  | { status: 'failed'; totals: ProcessTotals; message: string | null };

const EMPTY: ProcessTotals = { processed: 0, failed: 0, byOutcome: {}, deleted: 0 };

const add = (totals: ProcessTotals, answer: Awaited<ReturnType<typeof emailReceiptsApi.receipts.processBatch>>): ProcessTotals => {
  const byOutcome = { ...totals.byOutcome };
  for (const [status, count] of Object.entries(answer.byOutcome) as Array<[EmailReceiptStatus, number]>) {
    byOutcome[status] = (byOutcome[status] ?? 0) + count;
  }
  return {
    processed: totals.processed + answer.processed,
    failed: totals.failed + answer.failed,
    byOutcome,
    deleted: totals.deleted + (answer.deleted ?? 0),
  };
};

/**
 * "Process all": runs the server's bulk call in a loop until nothing is left, the
 * person cancels (the call in flight finishes first, the next is not sent) or a call
 * fails. One run covers each of `domains` in turn (`undefined` is every sender), optionally
 * limited to `statuses`. The
 * loop ends on the server's own `remaining` (0), and also when a call touched
 * nothing, so a server that stopped making progress cannot keep it going. The cache
 * is dropped when anything was processed: a run can apply what an email proposed.
 * Leaving the page stops the loop after the call in flight.
 */
export function useProcessStoredEmails() {
  const [state, setState] = useState<ProcessRunState>({ status: 'idle' });
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelRequested.current = true;
    };
  }, []);

  const publish = useCallback((next: ProcessRunState) => {
    if (mounted.current) setState(next);
  }, []);

  const run = useCallback(
    async (
      domains: ReadonlyArray<string | undefined>,
      statuses?: readonly EmailReceiptProcessableStatus[],
    ): Promise<ProcessTotals> => {
      if (running.current) return EMPTY;
      running.current = true;
      cancelRequested.current = false;
      let totals = EMPTY;
      publish({ status: 'running', totals, remaining: null, cancelling: false });
      try {
        for (const domain of domains) {
          let since: string | undefined;
          for (;;) {
            if (cancelRequested.current) break;
            const answer = await emailReceiptsApi.receipts.processBatch({
              ...(domain ? { domain } : {}),
              ...(statuses ? { statuses } : {}),
              ...(since ? { since } : {}),
            });
            totals = add(totals, answer);
            since = answer.since;
            publish({ status: 'running', totals, remaining: answer.remaining, cancelling: cancelRequested.current });
            if (answer.remaining <= 0 || answer.processed + answer.failed === 0) break;
          }
          if (cancelRequested.current) break;
        }
        publish({ status: 'done', totals, cancelled: cancelRequested.current });
      } catch (error) {
        logger.error(error);
        publish({ status: 'failed', totals, message: getErrorMessage(error, '') || null });
      } finally {
        running.current = false;
        if (totals.processed > 0) {
          clearAllCache();
          notifyAiAction();
        }
      }
      return totals;
    },
    [publish],
  );

  const cancel = useCallback(() => {
    cancelRequested.current = true;
    setState((current) => (current.status === 'running' ? { ...current, cancelling: true } : current));
  }, []);

  const dismiss = useCallback(() => setState({ status: 'idle' }), []);

  return { state, run, cancel, dismiss };
}
