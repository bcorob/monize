'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/** Where the mailbox settings live now: the hub's Mailbox tab. */
export const MAILBOX_HUB_HREF = '/email-receipts?tab=mailbox';

export default function EmailReceiptsSettingsPage() {
  return (
    <ProtectedRoute>
      <EmailReceiptsSettingsRedirect />
    </ProtectedRoute>
  );
}

/**
 * The page the mailbox and the parsers used to be on. They moved to the Email
 * Receipts hub (`/email-receipts`), so a bookmark or an old link goes there, to the
 * Mailbox tab; the link is also drawn for a browser that does not follow the redirect.
 */
function EmailReceiptsSettingsRedirect() {
  const t = useTranslations('emailReceipts.settingsPage');
  const router = useRouter();

  useEffect(() => {
    router.replace(MAILBOX_HUB_HREF);
  }, [router]);

  return (
    <main className="flex flex-col items-center gap-3 px-4 pt-12">
      <LoadingSpinner text={t('redirecting')} />
      <Link href={MAILBOX_HUB_HREF} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        {t('redirectLink')}
      </Link>
    </main>
  );
}
