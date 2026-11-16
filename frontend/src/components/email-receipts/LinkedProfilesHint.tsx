'use client';

import { useTranslations } from 'next-intl';
import { MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN } from '@/types/email-receipts';

interface LinkedProfilesHintProps {
  /** `emails`: beside the draft action on the Emails tab; `profiles`: beside the per-domain wizard. */
  variant: 'emails' | 'profiles';
  /** The Profiles hint's link: opens the Emails tab. Absent, no link is drawn. */
  onOpenEmails?: () => void;
}

/** The always-shown fact that one transaction described by several senders is drafted from a selection of their emails. */
export function LinkedProfilesHint({ variant, onOpenEmails }: LinkedProfilesHintProps) {
  const t = useTranslations('emailReceipts.linkedHint');
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400">
      {t(variant, { max: MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN })}
      {variant === 'profiles' && onOpenEmails && (
        <>
          {' '}
          <button
            type="button"
            onClick={onOpenEmails}
            className="font-medium text-blue-600 underline hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            {t('openEmails')}
          </button>
        </>
      )}
    </p>
  );
}
