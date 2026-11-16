'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { DraftBlock } from '@/lib/email-receipts-format';
import { hasExclusions, type Deselection, type SelectionExclusions } from '@/lib/receipt-selection';
import {
  MAX_PARSER_DRAFT_DOMAINS,
  MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
  type EmailReceiptStatus,
} from '@/types/email-receipts';
import type { ReprocessProgress } from '@/components/email-receipts/useReceiptBulkProcessing';

/** A command that is shown only for some selections, and the number it names when that is known. */
export interface BulkCommandOffer {
  visible: boolean;
  /** `null` when the server, not the page, knows the number ("every email matching"). */
  count: number | null;
}

interface ReceiptBulkBarProps {
  /** Emails the selection holds: the ticked rows, or every email matching the filter. */
  count: number;
  /** The selection is "every email matching the filter", not the ticked rows. */
  allMatching: boolean;
  /** Rows on the page. */
  pageCount: number;
  /** Ticked emails that are not in the list on screen (another page, state or sender). */
  hiddenCount: number;
  /** How many emails match the filter, as the server counts them; null while unknown or failed. */
  matchingTotal: number | null;
  /** Every row of the page is ticked and more emails match the filter. */
  canSelectAllMatching: boolean;
  /** Why the draft button is off, or null when it is on. */
  draftBlock: DraftBlock | null;
  /** The sender domains of the selection, for the reasons that name them. */
  senderDomains: readonly string[];
  /** A command is running: nothing in the bar can be pressed. */
  busy: boolean;
  drafting: boolean;
  /** The server is counting the narrowed selection: the number is not final. */
  countPending: boolean;
  /** Reprocess or restore run: the bar shows where it is and a Stop button. */
  progress: ReprocessProgress | null;
  restore: BulkCommandOffer;
  approve: BulkCommandOffer;
  /** States and sender domains the "Deselect by" menu offers. */
  statusOptions: readonly EmailReceiptStatus[];
  domainOptions: readonly string[];
  /** What was taken out of an "every email matching" selection; shown as removable chips. */
  exclusions: SelectionExclusions;
  onSelectAllMatching: () => void;
  onReprocess: () => void;
  onRestore: () => void;
  onApprove: () => void;
  onStop: () => void;
  onDeselect: (deselection: Deselection) => void;
  onChangeExclusions: (next: SelectionExclusions) => void;
  onDelete: () => void;
  onIgnore: () => void;
  onDraft: () => void;
  onClear: () => void;
}

/**
 * The bar over the list while emails are selected: how many, the commands on
 * them (Reprocess, Restore ignored, Approve proposals, Delete, Ignore, Prepare a
 * profile with AI), the "Deselect by" menu (state, sender, received day) and,
 * Gmail style, the offer to widen a full page to every email matching the filter. The draft button is on
 * only for one to five emails of each of one to five senders; when it is off, a line beside it says
 * why and the button points at that line.
 */
export function ReceiptBulkBar({
  count,
  allMatching,
  pageCount,
  hiddenCount,
  matchingTotal,
  canSelectAllMatching,
  draftBlock,
  senderDomains,
  busy,
  drafting,
  countPending,
  progress,
  restore,
  approve,
  statusOptions,
  domainOptions,
  exclusions,
  onSelectAllMatching,
  onReprocess,
  onRestore,
  onApprove,
  onStop,
  onDeselect,
  onChangeExclusions,
  onDelete,
  onIgnore,
  onDraft,
  onClear,
}: ReceiptBulkBarProps) {
  const t = useTranslations('emailReceipts.receipts.selection');
  const tFilter = useTranslations('emailReceipts.receipts.filter');
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const reasonId = useId();
  const [dayFor, setDayFor] = useState<'before' | 'after' | null>(null);
  const [day, setDay] = useState('');
  const disabled = busy || drafting || countPending;
  const shown = formatNumber(count, 0);
  const narrowed = hasExclusions(exclusions);

  const deselectItems: ActionMenuItem[] = [
    ...statusOptions.map((status) => ({
      id: `status-${status}`,
      label: t('deselect.state', { state: tFilter(status) }),
      disabled,
      onSelect: () => onDeselect({ kind: 'status', status }),
    })),
    ...domainOptions.map((domain) => ({
      id: `domain-${domain}`,
      label: t('deselect.sender', { domain }),
      disabled,
      onSelect: () => onDeselect({ kind: 'domain', domain }),
    })),
    { id: 'before', label: t('deselect.before'), disabled, onSelect: () => setDayFor('before') },
    { id: 'after', label: t('deselect.after'), disabled, onSelect: () => setDayFor('after') },
  ];

  const applyDay = () => {
    if (dayFor === null || day === '') return;
    onDeselect({ kind: dayFor, day });
    setDayFor(null);
    setDay('');
  };

  const chips: { id: string; label: string; next: SelectionExclusions }[] = [
    ...exclusions.statuses.map((status) => ({
      id: `status-${status}`,
      label: t('exclusion.state', { state: tFilter(status) }),
      next: { ...exclusions, statuses: exclusions.statuses.filter((s) => s !== status) },
    })),
    ...exclusions.domains.map((domain) => ({
      id: `domain-${domain}`,
      label: t('exclusion.sender', { domain }),
      next: { ...exclusions, domains: exclusions.domains.filter((d) => d !== domain) },
    })),
    ...(exclusions.from !== null
      ? [{ id: 'from', label: t('exclusion.from', { date: formatDate(exclusions.from) }), next: { ...exclusions, from: null } }]
      : []),
    ...(exclusions.to !== null
      ? [{ id: 'to', label: t('exclusion.to', { date: formatDate(exclusions.to) }), next: { ...exclusions, to: null } }]
      : []),
  ];

  return (
    <div
      role="region"
      aria-label={t('label')}
      className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-100"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span>{t('count', { count })}</span>
        <Button disabled={disabled} onClick={onReprocess}>
          {t('reprocessButton', { count: shown })}
        </Button>
        {restore.visible && (
          <Button variant="outline" disabled={disabled} onClick={onRestore}>
            {restore.count !== null
              ? t('restoreButton', { count: formatNumber(restore.count, 0) })
              : t('restoreButtonAll')}
          </Button>
        )}
        {approve.visible && (
          <Button variant="outline" disabled={disabled} onClick={onApprove}>
            {approve.count !== null
              ? t('approveButton', { count: formatNumber(approve.count, 0) })
              : t('approveButtonAll')}
          </Button>
        )}
        <Button variant="danger" disabled={disabled} onClick={onDelete}>
          {t('deleteButton', { count: shown })}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={onIgnore}>
          {t('ignoreButton', { count: shown })}
        </Button>
        <Button
          isLoading={drafting}
          disabled={disabled || draftBlock !== null}
          aria-describedby={draftBlock !== null ? reasonId : undefined}
          onClick={onDraft}
        >
          {t('draftButton', { count: shown })}
        </Button>
        <ActionMenu label={t('deselect.label')} items={deselectItems} />
        <Button variant="outline" disabled={disabled} onClick={onClear}>
          {t('clear')}
        </Button>
      </div>
      {progress !== null && (
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>
            {progress.remaining === null
              ? t('progressStarting')
              : t('progress', {
                  processed: formatNumber(progress.processed, 0),
                  remaining: formatNumber(progress.remaining, 0),
                })}
          </span>
          <Button variant="outline" disabled={progress.stopping} onClick={onStop}>
            {t('stop')}
          </Button>
        </div>
      )}
      {dayFor !== null && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <DateInput
            id="receipt-deselect-day"
            label={t(dayFor === 'before' ? 'deselect.beforeLabel' : 'deselect.afterLabel')}
            value={day}
            onDateChange={(date) => setDay(date)}
          />
          <Button disabled={disabled || day === ''} onClick={applyDay}>
            {t('deselect.apply')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDayFor(null);
              setDay('');
            }}
          >
            {t('deselect.cancel')}
          </Button>
        </div>
      )}
      {chips.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label={t('exclusion.label')}>
          {chips.map((chip) => (
            <li key={chip.id}>
              <Badge
                as="button"
                type="button"
                variant="blue"
                disabled={disabled}
                aria-label={t('exclusion.remove', { label: chip.label })}
                onClick={() => onChangeExclusions(chip.next)}
                className="inline-flex items-center gap-1 hover:bg-blue-200 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
              >
                {chip.label}
                <XMarkIcon className="h-3 w-3" aria-hidden="true" />
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {canSelectAllMatching && matchingTotal !== null && (
        <p>
          {t('pageSelected', { count: formatNumber(pageCount, 0) })}{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={onSelectAllMatching}
            className="font-medium text-blue-700 underline hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:text-blue-300"
          >
            {t('selectAllMatching', { total: formatNumber(matchingTotal, 0) })}
          </button>
        </p>
      )}
      {hiddenCount > 0 && <p>{t('hiddenSelected', { hidden: hiddenCount })}</p>}
      {allMatching && (
        <p>{t(narrowed ? 'narrowedSelected' : 'allMatchingSelected', { total: formatNumber(count, 0) })}</p>
      )}
      {draftBlock !== null && (
        <p id={reasonId} className="text-amber-800 dark:text-amber-200">
          {t(`draftBlocked.${draftBlock}`, {
            max: MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
            perDomain: MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
            maxDomains: MAX_PARSER_DRAFT_DOMAINS,
            domains: senderDomains.join(', '),
          })}
        </p>
      )}
    </div>
  );
}
