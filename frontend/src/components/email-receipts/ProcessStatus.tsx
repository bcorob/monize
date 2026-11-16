'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { ProcessRunState, ProcessTotals } from '@/hooks/useProcessStoredEmails';
import type { EmailReceiptStatus } from '@/types/email-receipts';

interface ProcessStatusProps {
  state: ProcessRunState;
  onCancel: () => void;
  onDismiss: () => void;
}

/** The entries of where the processed emails ended: a status and how many, none with zero. */
function outcomeEntries(totals: ProcessTotals): Array<[EmailReceiptStatus, number]> {
  return (Object.entries(totals.byOutcome) as Array<[EmailReceiptStatus, number]>).filter(([, count]) => count > 0);
}

/**
 * What "Process all" is doing and what it did: progress while it runs (with
 * Cancel), then the totals and where the emails ended, or the reason a call failed
 * beside what had been done by then. Renders nothing while idle.
 */
export function ProcessStatus({ state, onCancel, onDismiss }: ProcessStatusProps) {
  const t = useTranslations('emailReceipts.process');
  const tf = useTranslations('emailReceipts.receipts.filter');
  const format = useFormatter();
  if (state.status === 'idle') return null;

  // "3 Review, 2 No parser": each count with its state's name as the list's own reading, so the separators are the locale's.
  // Emails a profile deleted have no state to end in: they are listed as deleted, last.
  const outcomes = format.list(
    [
      ...outcomeEntries(state.totals).map(([status, count]) => t('outcome', { count, state: tf(status) })),
      ...(state.totals.deleted > 0 ? [t('deletedOutcome', { count: state.totals.deleted })] : []),
    ],
    { type: 'unit' },
  );

  if (state.status === 'running') {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-100"
      >
        <span>
          {state.remaining === null
            ? t('starting')
            : t('progress', { processed: state.totals.processed, remaining: state.remaining })}
        </span>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={state.cancelling}>
          {state.cancelling ? t('cancelling') : t('cancel')}
        </Button>
      </div>
    );
  }

  const failed = state.status === 'failed';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={
        failed
          ? 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200'
          : 'rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-200'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {failed && <p className="font-semibold">{state.message ? t('failedWithReason', { reason: state.message }) : t('failed')}</p>}
          <p>
            {state.status === 'done' && state.cancelled
              ? t('cancelledSummary', { count: state.totals.processed })
              : t('summary', { count: state.totals.processed })}
            {state.totals.processed > 0 && <> {t('outcomes', { outcomes })}</>}
            {state.totals.failed > 0 && <> {t('passedOver', { count: state.totals.failed })}</>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
