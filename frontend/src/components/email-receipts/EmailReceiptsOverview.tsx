'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { FirstRunWizard } from '@/components/email-receipts/FirstRunWizard';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptsOverview } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptsOverview');

const LINK_CLASS = 'text-sm text-blue-600 hover:underline dark:text-blue-400';

/** The mailbox's state in one word and the colour it is drawn in; `error` outranks "off" because a failing poll is the news. */
function mailboxBadge(mailbox: NonNullable<EmailReceiptsOverview['mailbox']>): { key: string; variant: BadgeVariant } {
  if (!mailbox.connected) return { key: 'notConnected', variant: 'red' };
  if (mailbox.lastError !== null && (mailbox.lastSuccessAt === null || (mailbox.lastErrorAt ?? '') > mailbox.lastSuccessAt)) {
    return { key: 'failing', variant: 'red' };
  }
  if (!mailbox.enabled) return { key: 'off', variant: 'gray' };
  return { key: 'polling', variant: 'green' };
}

function OverviewCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card padding="md" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      {children}
    </Card>
  );
}

/** A figure with its caption, the way the cards state a count. */
function Figure({ value, caption }: { value: number; caption: string }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</span>
      <span className="text-sm text-gray-600 dark:text-gray-400">{caption}</span>
    </p>
  );
}

/**
 * The hub's Overview: what is connected, what is stored, what waits for a person
 * and what is not covered by a profile yet, from one request (`GET
 * /email-receipts/overview`). `overview === null` is loading or failed, never an
 * empty account; the first-run wizard is drawn only from a loaded answer.
 */
export function EmailReceiptsOverview() {
  const t = useTranslations('emailReceipts.overview');
  const { formatDateTime } = useDateFormat();
  const [overview, setOverview] = useState<EmailReceiptsOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped to read the overview again (the retry button); each value is one request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .overview()
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        setLoadFailed(false);
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        // An overview that could not be refreshed is not shown as if it were current.
        setOverview(null);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (overview === null && loadFailed) {
    return (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={
            <Button
              onClick={() => {
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  }
  if (overview === null) return <LoadingSpinner text={t('loading')} />;

  const { mailbox, emailsByStatus, processable, proposalsToApprove, parsers, domainsWithoutProfile } = overview;
  const stored = Object.values(emailsByStatus).reduce((sum, count) => sum + (count ?? 0), 0);
  const badge = mailbox ? mailboxBadge(mailbox) : null;

  return (
    <div className="space-y-6">
      <FirstRunWizard overview={overview} stored={stored} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OverviewCard title={t('mailbox.title')}>
          {mailbox && badge ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={badge.variant}>{t(`mailbox.state.${badge.key}`)}</Badge>
                <span className="text-sm text-gray-600 dark:text-gray-400">{t(`mailbox.auth.${mailbox.authMethod}`)}</span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {mailbox.lastSuccessAt
                  ? t('mailbox.lastSuccess', { when: formatDateTime(mailbox.lastSuccessAt) })
                  : t('mailbox.neverPolled')}
              </p>
              {mailbox.lastError !== null && (
                <p className="text-sm text-red-700 dark:text-red-300">{t('mailbox.lastError', { error: mailbox.lastError })}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('mailbox.none')}</p>
          )}
          <Link href="/email-receipts?tab=mailbox" className={LINK_CLASS}>
            {mailbox ? t('mailbox.manage') : t('mailbox.connect')}
          </Link>
        </OverviewCard>

        <OverviewCard title={t('emails.title')}>
          <Figure value={stored} caption={t('emails.stored')} />
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('emails.processable', { count: processable })}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/email-receipts?tab=emails" className={LINK_CLASS}>
              {t('emails.open')}
            </Link>
          </div>
        </OverviewCard>

        <OverviewCard title={t('proposals.title')}>
          <Figure value={proposalsToApprove} caption={t('proposals.waiting')} />
          <Link href="/ai-reviews?kind=email_receipt" className={LINK_CLASS}>
            {proposalsToApprove > 0 ? t('proposals.review') : t('proposals.open')}
          </Link>
        </OverviewCard>

        <OverviewCard title={t('profiles.title')}>
          <Figure value={parsers.approved} caption={t('profiles.approved')} />
          {parsers.draft > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-300">{t('profiles.drafts', { count: parsers.draft })}</p>
          )}
          <Link href="/email-receipts?tab=profiles" className={LINK_CLASS}>
            {t('profiles.manage')}
          </Link>
        </OverviewCard>

        <div className="md:col-span-2">
          <OverviewCard title={t('uncovered.title')}>
            {domainsWithoutProfile.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden />
                {t('uncovered.none')}
              </p>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('uncovered.help')}</p>
                <ul className={TABLE_BODY_CLASS}>
                  {domainsWithoutProfile.map((entry) => (
                    <li key={entry.domain} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0 break-all font-medium text-gray-900 dark:text-gray-100">
                        {t('uncovered.row', { domain: entry.domain, count: entry.count })}
                      </span>
                      <Link
                        href={`/email-receipts?tab=profiles&wizard=${encodeURIComponent(entry.domain)}`}
                        className={LINK_CLASS}
                      >
                        {t('uncovered.create')}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </OverviewCard>
        </div>
      </div>
    </div>
  );
}
