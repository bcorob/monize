'use client';

import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import type { BulkRequest } from '@/components/email-receipts/BulkConfirmDialog';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptBulkAction, EmailReceiptBulkFilter, EmailReceiptBulkResult } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptsBulk');

/** What a request names: the ticked emails' ids, or the list's filter. */
export type BulkScope = { ids: string[] } | { filter: EmailReceiptBulkFilter };

/**
 * The number the server found when it refused a bulk command because the count
 * differed (409 with `currentCount`), or `null` for any other failure.
 */
function conflictCount(error: unknown): number | null {
  const response = (error as { response?: { status?: unknown; data?: { currentCount?: unknown } } } | null)?.response;
  if (response?.status !== 409) return null;
  const count = response.data?.currentCount;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * Delete or ignore many stored emails after a yes. `ask` opens the confirmation
 * with the count the person was shown; `confirm` sends it as `expectedCount`. A
 * refusal for a changed count keeps the dialog open with the server's new number
 * (nothing was written) and reloads the page's own numbers; any other failure
 * closes it and says why. A success clears the selection (`onDone`), reloads and
 * tells what happened, including the emails left alone because a transaction
 * is linked.
 */
export function useReceiptBulkActions(options: { reload: () => Promise<void>; onDone: () => void }) {
  const t = useTranslations('emailReceipts.receipts.bulk');
  const { reload, onDone } = options;
  const [request, setRequest] = useState<(BulkRequest & { scope: BulkScope }) | null>(null);
  const [running, setRunning] = useState(false);

  const ask = useCallback((action: EmailReceiptBulkAction, scope: BulkScope, count: number) => {
    setRequest({ action, scope, count, filter: 'filter' in scope ? scope.filter : null, countChanged: false });
  }, []);

  const cancel = useCallback(() => setRequest(null), []);

  const tell = useCallback(
    (action: EmailReceiptBulkAction, result: EmailReceiptBulkResult) => {
      const parts = [t(action === 'delete' ? 'result.deleted' : 'result.ignored', { count: result.affected })];
      if (result.unchanged > 0) parts.push(t('result.unchanged', { count: result.unchanged }));
      if (result.notIgnorable > 0) parts.push(t('result.notIgnorable', { count: result.notIgnorable }));
      if (result.skippedLinked > 0) parts.push(t('result.skippedLinked', { count: result.skippedLinked }));
      const message = parts.join(' ');
      if (result.affected > 0) toast.success(message);
      else toast(message);
    },
    [t],
  );

  const confirm = useCallback(async () => {
    if (request === null || running) return;
    setRunning(true);
    try {
      const result = await emailReceiptsApi.receipts.bulk({
        action: request.action,
        expectedCount: request.count,
        ...request.scope,
      });
      setRequest(null);
      onDone();
      tell(request.action, result);
      await reload();
    } catch (error) {
      const current = conflictCount(error);
      if (current === null) {
        logger.error(error);
        setRequest(null);
        toast.error(getErrorMessage(error, t(request.action === 'delete' ? 'deleteFailed' : 'ignoreFailed')));
      } else if (current === 0) {
        setRequest(null);
        onDone();
        toast(t('noneLeft'));
        await reload();
      } else {
        setRequest({ ...request, count: current, countChanged: true });
        await reload();
      }
    } finally {
      setRunning(false);
    }
  }, [request, running, onDone, reload, tell, t]);

  return { request, running, ask, cancel, confirm };
}
