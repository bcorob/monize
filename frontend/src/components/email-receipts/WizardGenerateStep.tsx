'use client';

import { useState } from 'react';
import { AxiosError } from 'axios';
import { useTranslations } from 'next-intl';
import type { ChosenTransaction, WizardDraft, WizardKind } from '@/components/email-receipts/profile-wizard-types';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { inputBaseClasses, cn } from '@/lib/utils';
import type { ParserSamplePair } from '@/types/email-receipts';

const logger = createLogger('WizardGenerateStep');

/** The server refuses a longer note (`feedback`, 2000 characters). */
const FEEDBACK_MAX = 2000;

export interface WizardSample {
  receiptId: string;
  /** The transaction the email paid for; null for a trade confirmation, which pays none. */
  chosen: ChosenTransaction | null;
  /** The email's subject, shown for a sample with no transaction. */
  subject: string;
}

interface WizardGenerateStepProps {
  domain: string;
  samples: readonly WizardSample[];
  kind: WizardKind;
  /** The draft being revised; null for the first run. */
  draft: WizardDraft | null;
  onGenerated: (draft: WizardDraft, answer: string) => void;
  /** The user's own agent answers: the request waits in the AI inbox (nothing was generated yet). */
  onQueued: (requestId: string) => void;
  onBack: () => void;
}

type Phase =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'failed'; /** A 422: the assistant ran and saved no draft. */ refused: boolean; answer: string | null; message: string | null };

/** The assistant's words in a 422 (a run that saved no draft): `answer`, else the server's `message`. */
function readRefusal(error: unknown): { answer: string | null; message: string | null } | null {
  if (!(error instanceof AxiosError) || error.response?.status !== 422) return null;
  const data: unknown = error.response.data;
  if (typeof data !== 'object' || data === null) return { answer: null, message: null };
  const record = data as Record<string, unknown>;
  const answer = typeof record.answer === 'string' && record.answer !== '' ? record.answer : null;
  const message = typeof record.message === 'string' && record.message !== '' ? record.message : null;
  return { answer, message };
}

/**
 * Step 2: send the pairs to the assistant and wait for its draft. The call is
 * synchronous and can take a minute, so the page says so (a user whose AI is their own
 * agent gets a request in the AI inbox instead, `onQueued`). A run that saves no draft
 * shows what the assistant answered, and the person can send it again. With a draft
 * already (the "Back to AI" path) a note to the assistant is required.
 */
export function WizardGenerateStep({ domain, samples, kind, draft, onGenerated, onQueued, onBack }: WizardGenerateStepProps) {
  const t = useTranslations('emailReceipts.profileWizard.generate');
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [feedback, setFeedback] = useState('');
  const revising = draft !== null;
  const note = feedback.trim();
  const running = phase.status === 'running';

  const send = async () => {
    setPhase({ status: 'running' });
    const pairs: ParserSamplePair[] = samples.flatMap((sample) =>
      sample.chosen ? [{ receiptId: sample.receiptId, transactionId: sample.chosen.transactionId }] : [],
    );
    try {
      const result = await emailReceiptsApi.parsers.generateWithAi({
        domain,
        ...(kind === 'trade'
          ? { kind: 'trade' as const, tradeReceiptIds: samples.map((sample) => sample.receiptId) }
          : { samples: pairs }),
        ...(draft ? { parserId: draft.parserId } : {}),
        ...(draft && note !== '' ? { feedback: note } : {}),
      });
      if (result.status === 'queued') {
        onQueued(result.requestId);
        return;
      }
      onGenerated({ parserId: result.parserId, revision: result.revision }, result.answer);
    } catch (error) {
      logger.error(error);
      const refusal = readRefusal(error);
      setPhase({
        status: 'failed',
        refused: refusal !== null,
        answer: refusal?.answer ?? null,
        message: refusal === null ? getErrorMessage(error, t('failed')) : refusal.message,
      });
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">{revising ? t('reviseHelp') : kind === 'trade' ? t('tradeHelp', { domain }) : t('help', { domain })}</p>
      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 text-sm dark:divide-gray-700 dark:border-gray-700">
        {samples.map((sample) => (
          <li key={sample.receiptId} className="p-3">
            <div className="font-medium text-gray-900 dark:text-gray-100">{sample.chosen?.subject ?? sample.subject}</div>
            <div className="text-gray-600 dark:text-gray-400">{sample.chosen ? sample.chosen.summary : t('tradeSample')}</div>
          </li>
        ))}
      </ul>

      {revising && (
        <div>
          <label htmlFor="profile-wizard-feedback" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('feedbackLabel')}
          </label>
          <textarea
            id="profile-wizard-feedback"
            rows={4}
            value={feedback}
            maxLength={FEEDBACK_MAX}
            disabled={running}
            placeholder={t('feedbackPlaceholder')}
            onChange={(e) => setFeedback(e.target.value)}
            className={cn(inputBaseClasses, 'border px-3 py-2 text-sm')}
          />
        </div>
      )}

      {running && (
        <div role="status">
          <LoadingSpinner text={t('running')} />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('runningHint')}</p>
        </div>
      )}

      {phase.status === 'failed' && (
        <div role="alert" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200">
          <p className="font-medium">{phase.refused ? t('noDraft') : t('sendFailed')}</p>
          {phase.answer !== null && <p className="whitespace-pre-wrap break-words">{phase.answer}</p>}
          {phase.message !== null && phase.answer === null && <p className="break-words">{phase.message}</p>}
          {phase.refused && <p>{t('tryAgain')}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={running} onClick={onBack}>
          {t('back')}
        </Button>
        <Button isLoading={running} disabled={running || (revising && note === '')} onClick={() => void send()}>
          {revising ? t('sendFeedback') : phase.status === 'failed' ? t('retry') : t('send')}
        </Button>
      </div>
    </div>
  );
}
