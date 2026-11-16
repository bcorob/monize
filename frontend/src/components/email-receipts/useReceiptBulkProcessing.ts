'use client';

import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptBulkApprovable, EmailReceiptBulkScope } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptsBulkProcessing');

/** Which command a run is: both read the emails again, a restore only the ignored ones. */
export type ReprocessKind = 'reprocess' | 'restore';

/** How far a run is: emails done so far, and how many are left (`null` before the first answer). */
export interface ReprocessProgress {
  kind: ReprocessKind;
  processed: number;
  remaining: number | null;
  stopping: boolean;
}

/**
 * Reprocess, restore and approve many emails. A reprocess run calls the server
 * until it answers `remaining` 0, carrying its `since` so each email is read
 * once; the person can stop between two calls. The run ends with one toast, the
 * list read again and the selection cleared (`onDone`). Approval opens a
 * confirmation first (`offerApproval`), then sends the request ids in chunks.
 */
export function useReceiptBulkProcessing(options: { reload: () => Promise<void>; onDone: () => void }) {
  const t = useTranslations('emailReceipts.receipts.bulk');
  const { reload, onDone } = options;
  const [progress, setProgress] = useState<ReprocessProgress | null>(null);
  const [approval, setApproval] = useState<EmailReceiptBulkApprovable | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [approving, setApproving] = useState(false);
  const stopRequested = useRef(false);
  const active = useRef(false);

  const stop = useCallback(() => {
    stopRequested.current = true;
    setProgress((current) => (current === null ? null : { ...current, stopping: true }));
  }, []);

  const reprocess = useCallback(
    async (scope: EmailReceiptBulkScope, kind: ReprocessKind) => {
      if (active.current) return;
      active.current = true;
      stopRequested.current = false;
      setProgress({ kind, processed: 0, remaining: null, stopping: false });
      let processed = 0;
      let failed = 0;
      let remaining = 0;
      let since: string | undefined;
      try {
        for (;;) {
          const result = await emailReceiptsApi.receipts.bulkReprocess({
            ...scope,
            ...(kind === 'restore' ? { onlyStatuses: ['ignored' as const] } : {}),
            ...(since !== undefined ? { since } : {}),
          });
          processed += result.processed;
          failed += result.failed;
          remaining = result.remaining;
          since = result.since;
          setProgress({ kind, processed: processed + failed, remaining, stopping: stopRequested.current });
          // A call that did nothing while emails remain would never end: stop rather than loop.
          if (remaining === 0 || stopRequested.current || result.processed + result.failed === 0) break;
        }
        const parts = [t(kind === 'restore' ? 'result.restored' : 'result.reprocessed', { count: processed })];
        if (failed > 0) parts.push(t('result.reprocessFailed', { count: failed }));
        if (remaining > 0) parts.push(t('result.stopped', { count: remaining }));
        const message = parts.join(' ');
        if (processed > 0 && failed === 0 && remaining === 0) toast.success(message);
        else toast(message);
        onDone();
      } catch (error) {
        logger.error(error);
        toast.error(getErrorMessage(error, t('reprocessFailed')));
      } finally {
        active.current = false;
        setProgress(null);
        await reload();
      }
    },
    [onDone, reload, t],
  );

  /** Open the confirmation for proposals the caller already knows (ticked rows). */
  const offerApproval = useCallback(
    (found: EmailReceiptBulkApprovable) => {
      if (found.requestIds.length === 0) toast(t('noApprovable'));
      else setApproval(found);
    },
    [t],
  );

  /** Ask the server which proposals a filter's emails hold, then open the confirmation. */
  const askApprovalFor = useCallback(
    async (scope: EmailReceiptBulkScope) => {
      if (preparing) return;
      setPreparing(true);
      try {
        offerApproval(await emailReceiptsApi.receipts.bulkApprovable(scope));
      } catch (error) {
        logger.error(error);
        toast.error(getErrorMessage(error, t('approveFailed')));
      } finally {
        setPreparing(false);
      }
    },
    [preparing, offerApproval, t],
  );

  const cancelApproval = useCallback(() => setApproval(null), []);

  const confirmApproval = useCallback(async () => {
    const target = approval;
    setApproval(null);
    if (target === null || approving) return;
    setApproving(true);
    try {
      const result = await emailReceiptsApi.receipts.approveRequests(target.requestIds);
      const parts = [t('result.approved', { count: result.approved })];
      if (result.failed > 0) parts.push(t('result.approveFailed', { count: result.failed }));
      if (result.failed === 0) toast.success(parts.join(' '));
      else if (result.approved === 0) toast.error(parts.join(' '));
      else toast(parts.join(' '));
      onDone();
    } catch (error) {
      logger.error(error);
      toast.error(getErrorMessage(error, t('approveFailed')));
    } finally {
      setApproving(false);
      await reload();
    }
  }, [approval, approving, onDone, reload, t]);

  return {
    progress,
    approval,
    /** Any of the commands is working: the bar and the rows are locked. */
    running: progress !== null || preparing || approving,
    reprocess,
    stop,
    offerApproval,
    askApprovalFor,
    cancelApproval,
    confirmApproval,
  };
}
