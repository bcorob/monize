'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LinkedProfilesHint } from '@/components/email-receipts/LinkedProfilesHint';
import { SenderDomainCloud } from '@/components/email-receipts/SenderDomainCloud';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import type { UncoveredDomain } from '@/types/email-receipts';

const logger = createLogger('UncoveredDomains');

interface UncoveredDomainsSectionProps {
  /** A domain was clicked: the profile wizard starts for it. */
  onSelect: (domain: string) => void;
  /** Bumped by the parent to read the list again (a wizard finished). */
  refreshKey?: number;
  disabled?: boolean;
  /** Opens the Emails tab, where linked profiles start from a selection. */
  onOpenEmails?: () => void;
}

/**
 * "Create a profile for a domain": the sender domains of stored emails that no
 * approved profile covers, as the same cloud the Emails tab filters with. `domains
 * === null` is loading or failed, never "every domain is covered".
 */
export function UncoveredDomainsSection({ onSelect, refreshKey = 0, disabled = false, onOpenEmails }: UncoveredDomainsSectionProps) {
  const t = useTranslations('emailReceipts.profileWizard.uncovered');
  const [domains, setDomains] = useState<UncoveredDomain[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const found = await emailReceiptsApi.receipts.listUncovered();
        if (cancelled) return;
        setDomains(found);
        setFailed(false);
      } catch (error) {
        if (cancelled) return;
        logger.error(error);
        setFailed(true);
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, attempt]);

  const waitingDomains = useMemo(
    () => new Set((domains ?? []).filter((entry) => Boolean(entry.pendingRequestId)).map((entry) => entry.domain)),
    [domains],
  );

  // The tour spotlights the block only when it holds domains; an empty, loading or failed block gets the tour's centered stand-in instead.
  const hasDomains = !failed && domains !== null && domains.length > 0;

  return (
    <section {...(hasDomains ? tourAnchor(TOUR_ANCHORS.emailReceiptsUncovered) : {})} aria-labelledby="email-receipts-uncovered-heading" className="mb-6 space-y-2 rounded-lg border-2 border-blue-500 bg-blue-50/60 p-4 dark:border-blue-400 dark:bg-blue-900/20">
      <h2 id="email-receipts-uncovered-heading" className="text-xl font-bold text-blue-900 dark:text-blue-100">
        {t('heading')}
      </h2>
      <p className="text-sm text-gray-700 dark:text-gray-300">{t('help')}</p>
      <LinkedProfilesHint variant="profiles" onOpenEmails={onOpenEmails} />
      {failed ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">{t('error')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : domains === null ? (
        <LoadingSpinner text={t('loading')} />
      ) : domains.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('none')}</p>
      ) : (
        <div className={disabled ? 'pointer-events-none opacity-60' : undefined}>
          <SenderDomainCloud domains={domains} selected="" showAll={false} waitingDomains={waitingDomains} onSelect={(domain) => domain !== '' && onSelect(domain)} />
        </div>
      )}
    </section>
  );
}
