'use client';

import { useEffect, useState } from 'react';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ProcessStatus } from '@/components/email-receipts/ProcessStatus';
import type { WizardDraft, WizardKind } from '@/components/email-receipts/profile-wizard-types';
import { WizardPreviewTables, type PreviewAccount } from '@/components/email-receipts/WizardPreviewTables';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useProcessStoredEmails } from '@/hooks/useProcessStoredEmails';
import { accountsApi } from '@/lib/accounts';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { ParserPreviewResult, ParserSamplePair } from '@/types/email-receipts';

const logger = createLogger('WizardPreviewStep');

interface WizardPreviewStepProps {
  domain: string;
  draft: WizardDraft;
  /** What the profile reads, as the wizard was told: it decides the samples table's columns. */
  kind: WizardKind;
  /** What the assistant said about the draft, when this preview follows a run. */
  answer: string | null;
  /** The ticked samples and the transactions they were paired with; empty when starting from an existing draft. */
  pairs: readonly ParserSamplePair[];
  /** The ticked emails when they differ from the pairs' (a trade sample has no transaction to pair). */
  selectedReceiptIds?: readonly string[];
  /** Revising needs samples to send; false when the wizard started from an existing draft. */
  canReviseWithAi: boolean;
  onBackToAi: () => void;
  onBackToSamples: () => void;
  /** The draft was approved and its domain processed: lists behind the wizard are read again. */
  onAccepted: () => void;
  onClose: () => void;
}

type PreviewState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; result: ParserPreviewResult };

/** The accounts a trade preview names, by id; null while they load or when they could not be read (never an empty map). */
type AccountsState = ReadonlyMap<string, PreviewAccount> | null;

/**
 * Step 3 and 4: run the draft over the domain's emails (read-only), show the two
 * tables, and let the person accept it or send it back. Accepting approves the draft
 * and processes the domain's emails, then reports where they ended. Mount it keyed on
 * the draft's id and revision, so a revised draft is previewed afresh.
 */
export function WizardPreviewStep({ domain, draft, kind, answer, pairs, selectedReceiptIds, canReviseWithAi, onBackToAi, onBackToSamples, onAccepted, onClose }: WizardPreviewStepProps) {
  const t = useTranslations('emailReceipts.profileWizard.preview');
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const { state: processState, run, cancel, dismiss } = useProcessStoredEmails();
  // A trade sample books to an account the reading names by id: shown by name and
  // currency, so two same-named accounts (RRSP in CAD and in USD) are told apart.
  const [accounts, setAccounts] = useState<AccountsState>(null);

  useEffect(() => {
    if (kind !== 'trade') return;
    let cancelled = false;
    // Closed accounts too: a profile may still name one.
    accountsApi
      .getAll(true)
      .then((found) => {
        if (!cancelled) setAccounts(new Map(found.map((account) => [account.id, { name: account.name, currencyCode: account.currencyCode }])));
      })
      .catch((error) => {
        if (!cancelled) logger.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.parsers
      .preview(draft.parserId, {
        selectedReceiptIds: selectedReceiptIds ? [...selectedReceiptIds] : pairs.map((pair) => pair.receiptId),
        ...(pairs.length > 0 ? { expected: [...pairs] } : {}),
      })
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', result });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [draft.parserId, draft.revision, pairs, selectedReceiptIds, attempt]);

  const accept = async () => {
    setAccepting(true);
    try {
      await emailReceiptsApi.parsers.approve(draft.parserId, draft.revision ?? undefined);
    } catch (error) {
      setAccepting(false);
      const conflict = error instanceof AxiosError && error.response?.status === 409;
      toast.error(conflict ? t('changedElsewhere') : getErrorMessage(error, t('approveFailed')));
      return;
    }
    toast.success(t('approved'));
    setAccepted(true);
    await run([domain]);
    setAccepting(false);
    onAccepted();
  };

  if (accepted) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-700 dark:text-gray-300">{t('approvedProcessing', { domain })}</p>
        <ProcessStatus state={processState} onCancel={cancel} onDismiss={dismiss} />
        <Button disabled={accepting} onClick={onClose}>
          {t('done')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {answer !== null && answer !== '' && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
          <p className="mb-1 font-medium text-gray-900 dark:text-gray-100">{t('assistantSaid')}</p>
          <p className="whitespace-pre-wrap break-words">{answer}</p>
        </div>
      )}
      {state.status === 'loading' ? (
        <LoadingSpinner text={t('loading')} />
      ) : state.status === 'error' ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">{t('error')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('help')}</p>
          <WizardPreviewTables result={state.result} kind={kind} accounts={accounts} />
          {state.result.selected.length === 0 && state.result.others.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('nothingToShow')}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={accepting} onClick={onBackToSamples}>
          {t('backToSamples')}
        </Button>
        {canReviseWithAi && (
          <Button variant="outline" disabled={accepting} onClick={onBackToAi}>
            {t('backToAi')}
          </Button>
        )}
        <Button isLoading={accepting} disabled={accepting || state.status !== 'ready'} onClick={() => void accept()}>
          {t('accept')}
        </Button>
      </div>
    </div>
  );
}
