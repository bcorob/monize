'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { notifyAiAction } from '@/lib/aiActionSignal';
import { clearAllCache } from '@/lib/apiCache';
import { profileActionCounts, sweepProfileEmails } from '@/lib/email-receipts-profile-batch';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { discardModeOf } from '@/lib/receipt-parser-form';
import type { EmailReceiptParser, ReceiptDiscardMode } from '@/types/email-receipts';

const logger = createLogger('ProfileDiscardOffer');

/** What a profile would do to its stored emails, counted and waiting for the person to confirm it. */
interface DiscardOffer {
  parser: EmailReceiptParser;
  action: ReceiptDiscardMode;
  /** Emails the action would ignore or delete. */
  acts: number;
  /** Matched emails it keeps as they are (applied, or unreadable for ignore). */
  kept: number;
}

/**
 * A profile that ignores or deletes its emails (`discard`) acts on new mail by
 * itself. The emails already stored that it matches (as the pipeline chooses
 * the profile, whatever their state) are offered by `offer` once the profile is
 * approved and saved: counted first, then asked about with the numbers.
 * Nothing is asked when there is nothing to act on, or when the count could
 * not be read. `onDone` runs after the emails were acted on, even part-way.
 */
export function useProfileDiscardOffer(onDone: () => void) {
  const t = useTranslations('emailReceipts.parsers');
  const [pending, setPending] = useState<DiscardOffer | null>(null);

  const offer = async (parser: EmailReceiptParser) => {
    const action = parser.status === 'approved' ? discardModeOf(parser.definition) : null;
    if (action === null) return;
    try {
      const { acts, kept } = profileActionCounts(await sweepProfileEmails(parser.id, 'count'), action);
      if (acts > 0) setPending({ parser, action, acts, kept });
    } catch (error) {
      logger.error(error);
    }
  };

  const confirm = async () => {
    const current = pending;
    setPending(null);
    if (!current) return;
    try {
      const { done } = await sweepProfileEmails(current.parser.id, current.action);
      toast.success(t(current.action === 'ignore' ? 'toasts.emailsIgnored' : 'toasts.emailsDeleted', { count: done }));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.bulkFailed')));
    } finally {
      // Emails and their review requests changed (closed requests leave the queue), even after a failure part-way.
      clearAllCache();
      notifyAiAction();
      onDone();
    }
  };

  const dialog = (
    <ConfirmDialog
      isOpen={pending !== null}
      title={t(pending?.action === 'delete' ? 'bulk.deleteTitle' : 'bulk.ignoreTitle')}
      message={t(pending?.action === 'delete' ? 'bulk.deleteMessage' : 'bulk.ignoreMessage', {
        count: pending?.acts ?? 0,
        kept: pending?.kept ?? 0,
        name: pending?.parser.name ?? '',
      })}
      confirmLabel={t(pending?.action === 'delete' ? 'bulk.deleteConfirm' : 'bulk.ignoreConfirm')}
      cancelLabel={t('processOffer.later')}
      variant={pending?.action === 'delete' ? 'danger' : 'warning'}
      onConfirm={() => void confirm()}
      onCancel={() => setPending(null)}
    />
  );

  return { offer, dialog };
}
