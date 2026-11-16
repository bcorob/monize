'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ReceiptStateBadge } from '@/components/email-receipts/ReceiptStateBadge';
import { WIZARD_MAX_SAMPLES, type ChosenTransaction, type WizardKind } from '@/components/email-receipts/profile-wizard-types';
import { SampleDialog } from '@/components/email-receipts/WizardSampleDialogs';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLongPress } from '@/hooks/useLongPress';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptListItem } from '@/types/email-receipts';

const logger = createLogger('WizardSamplesStep');

const CHECKBOX_CLASS =
  'h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600';

interface WizardSamplesStepProps {
  domain: string;
  /** The transaction chosen for each email, by receipt id. Held by the wizard; nothing is written. */
  picks: Readonly<Record<string, ChosenTransaction>>;
  selected: ReadonlySet<string>;
  /** `trade`: the emails are brokerage trade confirmations, which pay no bank transaction, so none is chosen. */
  kind: WizardKind;
  onKindChange: (kind: WizardKind) => void;
  /** Remembers a ticked email's subject, which names a trade sample (it has no transaction line). */
  onSubject: (receiptId: string, subject: string) => void;
  onPick: (receiptId: string, chosen: ChosenTransaction) => void;
  onToggle: (receiptId: string) => void;
  onContinue: () => void;
}

type ListState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: EmailReceiptListItem[] };

/**
 * Step 1: the domain's stored emails. Each can be opened (read-only) and paired with
 * the transaction it paid for; an email can be ticked as a sample only once it has one,
 * and at most five are ticked. The pairs live in the wizard's state.
 */
export function WizardSamplesStep({ domain, picks, selected, kind, onKindChange, onSubject, onPick, onToggle, onContinue }: WizardSamplesStepProps) {
  const t = useTranslations('emailReceipts.profileWizard.samples');
  const { formatDateTime } = useDateFormat();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<EmailReceiptListItem | null>(null);
  const { getRowHandlers } = useLongPress<EmailReceiptListItem>({ onLongPress: () => {}, onClick: setOpened });

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .list(undefined, undefined, domain)
      .then((items) => {
        if (!cancelled) setList({ status: 'ready', items });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setList({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [domain, attempt]);

  if (list.status === 'loading') return <LoadingSpinner text={t('loading')} />;
  if (list.status === 'error') {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-red-600 dark:text-red-400">{t('error')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setList({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (list.items.length === 0) return <EmptyState title={t('empty.title')} description={t('empty.body', { domain })} />;

  const full = selected.size >= WIZARD_MAX_SAMPLES;
  const isTrade = kind === 'trade';

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={isTrade}
          onChange={(e) => onKindChange(e.target.checked ? 'trade' : 'receipt')}
          className={`mt-0.5 ${CHECKBOX_CLASS}`}
        />
        <span>{t('tradeToggle')}</span>
      </label>
      <p className="text-sm text-gray-600 dark:text-gray-400">{isTrade ? t('tradeHelp', { max: WIZARD_MAX_SAMPLES }) : t('help', { max: WIZARD_MAX_SAMPLES })}</p>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th className="w-8 px-2 sm:px-4">{t('columns.select')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.date')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.email')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.transaction')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {list.items.map((receipt) => {
              const pick = picks[receipt.id];
              const isSelected = selected.has(receipt.id);
              const blockedReason = pick === undefined && !isTrade ? t('needsTransaction') : !isSelected && full ? t('limitReached', { max: WIZARD_MAX_SAMPLES }) : undefined;
              return (
                <tr
                  key={receipt.id}
                  {...getRowHandlers(receipt)}
                  tabIndex={0}
                  onKeyDown={activateOnKey(() => setOpened(receipt))}
                  className={`cursor-pointer ${HOVER_ROW_ON_CARD} ${INTERACTIVE_ROW_FOCUS_CLASS}`}
                >
                  <Td className="px-2 align-top sm:px-4">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={blockedReason !== undefined}
                      title={blockedReason}
                      onChange={() => {
                        onSubject(receipt.id, receipt.subject);
                        onToggle(receipt.id);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={t('select', { subject: receipt.subject })}
                      className={CHECKBOX_CLASS}
                    />
                  </Td>
                  <Td className="px-2 align-top whitespace-nowrap sm:px-4">{formatDateTime(receipt.effectiveDate)}</Td>
                  <Td className="min-w-0 px-2 align-top break-words sm:px-4">
                    <div className="font-medium">{receipt.subject}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span>{receipt.fromAddress}</span>
                      <ReceiptStateBadge receipt={receipt} />
                    </div>
                  </Td>
                  <Td className="min-w-0 px-2 align-top break-words sm:px-4">
                    {isTrade ? (
                      <span className="text-gray-500 dark:text-gray-400">{t('tradeNoTransaction')}</span>
                    ) : pick ? (
                      pick.summary
                    ) : (
                      <span className="text-gray-500 dark:text-gray-400">{t('noTransaction')}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {t('selectedCount', { count: selected.size, max: WIZARD_MAX_SAMPLES })}
        </span>
        <Button disabled={selected.size === 0} onClick={onContinue}>
          {t('continue')}
        </Button>
      </div>

      {opened !== null && (
        <SampleDialog
          receipt={opened}
          domain={domain}
          onClose={() => setOpened(null)}
          onChosen={(chosen) => {
            onPick(opened.id, { ...chosen, subject: opened.subject });
            setOpened(null);
          }}
        />
      )}
    </div>
  );
}
