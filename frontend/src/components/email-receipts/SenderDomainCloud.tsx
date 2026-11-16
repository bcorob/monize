'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { EmailReceiptDomainCount } from '@/types/email-receipts';

interface SenderDomainCloudProps {
  /** The sender domains of the emails in the state on screen; `null` while unknown or failed. */
  domains: readonly EmailReceiptDomainCount[] | null;
  /** The domain being filtered on, `''` for all senders. */
  selected: string;
  onSelect: (domain: string) => void;
  /** Offer "All senders" first (the Emails tab's filter); off where a domain must be chosen. */
  showAll?: boolean;
  /** Domains with a request waiting in the AI inbox: each tag carries a "waiting for AI" badge. */
  waitingDomains?: ReadonlySet<string>;
}

const TAG_BASE =
  'rounded-full border px-3 py-1 leading-tight focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none';
const TAG_IDLE = `border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200 ${HOVER_ROW_ON_PAGE}`;
const TAG_ON = 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500';

/** A tag grows with its share of the busiest domain, in three steps: the cloud is read at a glance, never by number alone. */
function sizeClass(count: number, max: number): string {
  const share = max > 0 ? count / max : 0;
  if (share >= 2 / 3) return 'text-base font-semibold';
  if (share >= 1 / 3) return 'text-sm font-medium';
  return 'text-xs';
}

/**
 * The sender domains as a tag cloud, counted within the state being looked at:
 * one toggle button per domain with its email count, and "All senders" first.
 * The filtered domain stays on screen even when the state has none of its emails.
 */
export function SenderDomainCloud({ domains, selected, onSelect, showAll = true, waitingDomains }: SenderDomainCloudProps) {
  const t = useTranslations('emailReceipts.receipts.domainFilter');
  const { formatNumber } = useNumberFormat();
  const list = domains ?? [];
  const max = list.reduce((largest, entry) => Math.max(largest, entry.count), 0);
  const selectedMissing = selected !== '' && !list.some((entry) => entry.domain === selected);

  return (
    <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
      {showAll && (
        <button
          type="button"
          aria-pressed={selected === ''}
          onClick={() => onSelect('')}
          className={`${TAG_BASE} text-sm ${selected === '' ? TAG_ON : TAG_IDLE}`}
        >
          {t('all')}
        </button>
      )}
      {selectedMissing && (
        <button type="button" aria-pressed onClick={() => onSelect('')} className={`${TAG_BASE} text-sm ${TAG_ON}`}>
          {selected}
        </button>
      )}
      {list.map((entry) => (
        <button
          key={entry.domain}
          type="button"
          aria-pressed={selected === entry.domain}
          // Choosing the domain that is already on clears it: the tag is a toggle.
          onClick={() => onSelect(selected === entry.domain ? '' : entry.domain)}
          className={`${TAG_BASE} ${sizeClass(entry.count, max)} ${selected === entry.domain ? TAG_ON : TAG_IDLE}`}
        >
          {t('option', { domain: entry.domain, count: formatNumber(entry.count, 0) })}
          {waitingDomains?.has(entry.domain) && (
            <Badge variant="amber" className="ml-2 align-middle">
              {t('waitingForAi')}
            </Badge>
          )}
        </button>
      ))}
      {domains === null && <span className="text-xs text-gray-500 dark:text-gray-400">{t('unknown')}</span>}
    </div>
  );
}
