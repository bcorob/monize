'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { EmailReceiptBulkAction, EmailReceiptBulkFilter } from '@/types/email-receipts';

/** A bulk command waiting for the person's yes: what, to how many, and by which filter. */
export interface BulkRequest {
  action: EmailReceiptBulkAction;
  /** The number the person is asked about, and the one sent as `expectedCount`. */
  count: number;
  /** The filter the emails were chosen by; `null` when they were ticked one by one. */
  filter: EmailReceiptBulkFilter | null;
  /** The server found another number than the one asked about; `count` is the new one. */
  countChanged: boolean;
}

interface BulkConfirmDialogProps {
  request: BulkRequest | null;
  running: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The yes before a delete or an ignore of many emails. It states the count and
 * the filter, says a delete cannot be undone and offers Ignore (which keeps the
 * emails) instead. When the server refused because the number changed, the same
 * dialog stays open with the new number and says so: nothing was written.
 */
export function BulkConfirmDialog({ request, running, onConfirm, onCancel }: BulkConfirmDialogProps) {
  const t = useTranslations('emailReceipts.receipts.bulkDialog');
  const tc = useTranslations('common');
  const tf = useTranslations('emailReceipts.receipts');
  const { formatNumber } = useNumberFormat();

  const action = request?.action ?? 'delete';
  const domain = request?.filter?.domain;
  const status = request?.filter?.status;
  const narrowed =
    (request?.filter?.excludeStatuses?.length ?? 0) > 0 ||
    (request?.filter?.excludeDomains?.length ?? 0) > 0 ||
    request?.filter?.receivedFrom !== undefined ||
    request?.filter?.receivedTo !== undefined;
  // A search or a date range narrows the filter as well: the command acts on the searched emails only.
  const searched =
    request?.filter?.search !== undefined ||
    request?.filter?.dateFrom !== undefined ||
    request?.filter?.dateTo !== undefined;
  const scope = domain && status ? 'both' : domain ? 'domain' : status ? 'status' : 'other';

  return (
    <Modal
      isOpen={request !== null}
      onClose={running ? undefined : onCancel}
      title={t(`${action}.title`)}
      maxWidth="md"
      padding="md"
      footer={
        <>
          <Button variant="outline" disabled={running} onClick={onCancel}>
            {tc('cancel')}
          </Button>
          <Button
            variant={action === 'delete' ? 'danger' : 'primary'}
            isLoading={running}
            disabled={running}
            onClick={onConfirm}
          >
            {action === 'delete' ? tc('delete') : t('ignore.confirm')}
          </Button>
        </>
      }
    >
      {request !== null && (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
          {request.countChanged && (
            <p
              role="alert"
              className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200"
            >
              {t('countChanged', { count: formatNumber(request.count, 0) })}
            </p>
          )}
          <p>
            {t(`${action}.message`, {
              count: request.count,
              scope,
              domain: domain ?? '',
              status: status ? tf(`filter.${status}`) : '',
            })}
          </p>
          {searched && <p>{t('searchNote')}</p>}
          {narrowed && <p>{t('narrowedNote')}</p>}
        </div>
      )}
    </Modal>
  );
}
