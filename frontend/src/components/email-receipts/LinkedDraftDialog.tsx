'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MAX_PARSER_DRAFT_DOMAINS, MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN } from '@/types/email-receipts';

interface LinkedDraftDialogProps {
  isOpen: boolean;
  /** The sender domains of the selection with their email counts. */
  domains: readonly { domain: string; count: number }[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation before "Prepare a profile with AI" is sent for emails of
 * several sender domains: that is for ONE bank transaction whose facts are
 * spread over several senders; unrelated shops are drafted one domain at a time.
 */
export function LinkedDraftDialog({ isOpen, domains, onConfirm, onCancel }: LinkedDraftDialogProps) {
  const t = useTranslations('emailReceipts.receipts.linkedDraftDialog');
  const list = domains.map((entry) => t('domainEntry', { domain: entry.domain, count: entry.count })).join(', ');
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={t('title')}
      message={t('message', {
        domains: list,
        perDomain: MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
        maxDomains: MAX_PARSER_DRAFT_DOMAINS,
      })}
      confirmLabel={t('confirm')}
      variant="info"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
