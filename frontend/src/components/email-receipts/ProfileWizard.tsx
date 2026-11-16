'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { WIZARD_MAX_SAMPLES, type ChosenTransaction, type WizardDraft, type WizardKind } from '@/components/email-receipts/profile-wizard-types';
import { WizardGenerateStep, type WizardSample } from '@/components/email-receipts/WizardGenerateStep';
import { WizardPreviewStep } from '@/components/email-receipts/WizardPreviewStep';
import { WizardSamplesStep } from '@/components/email-receipts/WizardSamplesStep';
import { WizardWaitingStep, type WaitingBaseline } from '@/components/email-receipts/WizardWaitingStep';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import type { ParserSamplePair } from '@/types/email-receipts';

const logger = createLogger('ProfileWizard');

type Step = 'samples' | 'generate' | 'preview';
const STEPS: readonly Step[] = ['samples', 'generate', 'preview'];

interface ProfileWizardProps {
  /** The sender domain the profile is for; the hub keeps it in `?wizard=`. */
  domain: string;
  onClose: () => void;
  /** A profile was approved and its emails processed: the lists behind the wizard are read again. */
  onFinished: () => void;
}

/**
 * "Create a profile for a domain": pick sample emails and the transactions they paid
 * for, let the assistant write a draft, preview it over the domain's emails, then
 * accept it (approve and process the domain) or send it back with a note. The pairs
 * of email and transaction stay in this component's state; nothing is written to the
 * receipts before the draft is accepted. A domain that already has a draft can start
 * at the preview with it.
 */
export function ProfileWizard({ domain, onClose, onFinished }: ProfileWizardProps) {
  const t = useTranslations('emailReceipts.profileWizard');
  const [step, setStep] = useState<Step>('samples');
  const [picks, setPicks] = useState<Readonly<Record<string, ChosenTransaction>>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // A trade confirmation pays no bank transaction: its samples are emails only.
  const [kind, setKind] = useState<WizardKind>('receipt');
  // The subjects of the ticked emails, for the lines that name a sample with no transaction.
  const [subjects, setSubjects] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  // The draft the domain already has, from the uncovered list; null when there is none or it is unknown.
  const [existingDraftId, setExistingDraftId] = useState<string | null>(null);
  // Set while the user's own agent writes the profile (a request waits in the AI inbox); null otherwise.
  const [waiting, setWaiting] = useState<WaitingBaseline | null>(null);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .listUncovered()
      .then((found) => {
        if (cancelled) return;
        const entry = found.find((candidate) => candidate.domain === domain);
        setExistingDraftId(entry?.draftParserId ?? null);
        // A request already in the AI inbox for this domain: show the wait, not step 1.
        if (entry?.pendingRequestId) {
          setWaiting((current) => current ?? { parserId: entry.draftParserId, revision: null });
          setStep((current) => (current === 'samples' ? 'generate' : current));
        }
      })
      .catch((error) => logger.error(error));
    return () => {
      cancelled = true;
    };
  }, [domain]);

  const samples: WizardSample[] = useMemo(
    () =>
      [...selected].flatMap((receiptId): WizardSample[] => {
        if (kind === 'trade') return [{ receiptId, chosen: null, subject: subjects[receiptId] ?? '' }];
        const chosen = picks[receiptId];
        return chosen ? [{ receiptId, chosen, subject: chosen.subject }] : [];
      }),
    [selected, picks, kind, subjects],
  );
  const pairs: ParserSamplePair[] = useMemo(
    () => samples.flatMap((sample) => (sample.chosen ? [{ receiptId: sample.receiptId, transactionId: sample.chosen.transactionId }] : [])),
    [samples],
  );

  const tradeIds = useMemo(() => (kind === 'trade' ? samples.map((sample) => sample.receiptId) : undefined), [kind, samples]);

  const toggle = (receiptId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(receiptId)) next.delete(receiptId);
      else if (next.size < WIZARD_MAX_SAMPLES) next.add(receiptId);
      return next;
    });

  // Revising an existing draft with no samples is a preview only; "Back to AI" needs samples to send.
  const canReviseWithAi = samples.length > 0;

  return (
    <Card padding="md" className="mb-6 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('heading', { domain })}</h2>
          <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('stepsLabel')}>
            {STEPS.map((key, index) => (
              <li
                key={key}
                aria-current={step === key ? 'step' : undefined}
                className={step === key ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}
              >
                {t('stepName', { number: index + 1, name: t(`steps.${key}`) })}
              </li>
            ))}
          </ol>
        </div>
        <Button variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>

      {waiting !== null && (
        <WizardWaitingStep
          domain={domain}
          baseline={waiting}
          onArrived={(next) => {
            setWaiting(null);
            setDraft(next);
            setAnswer(null);
            setStep('preview');
          }}
          onStartOver={() => {
            setWaiting(null);
            setDraft(null);
            setStep('samples');
          }}
        />
      )}

      {waiting === null && step === 'samples' && (
        <>
          {existingDraftId !== null && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
              <span>{t('existingDraft')}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft({ parserId: existingDraftId, revision: null });
                  setAnswer(null);
                  setStep('preview');
                }}
              >
                {t('useExistingDraft')}
              </Button>
            </div>
          )}
          <WizardSamplesStep
            domain={domain}
            picks={picks}
            selected={selected}
            kind={kind}
            onKindChange={(next) => {
              setKind(next);
              setSelected(new Set());
            }}
            onSubject={(receiptId, subject) => setSubjects((current) => ({ ...current, [receiptId]: subject }))}
            onPick={(receiptId, chosen) => setPicks((current) => ({ ...current, [receiptId]: chosen }))}
            onToggle={toggle}
            onContinue={() => setStep('generate')}
          />
        </>
      )}

      {waiting === null && step === 'generate' && (
        <WizardGenerateStep
          domain={domain}
          samples={samples}
          kind={kind}
          draft={draft}
          onQueued={() => {
            // The agent revises or writes the draft later: wait on what the domain has now.
            setWaiting(draft ? { parserId: draft.parserId, revision: draft.revision } : { parserId: existingDraftId, revision: null });
          }}
          onBack={() => setStep(draft ? 'preview' : 'samples')}
          onGenerated={(next, said) => {
            setDraft(next);
            setAnswer(said);
            setStep('preview');
          }}
        />
      )}

      {waiting === null && step === 'preview' && draft !== null && (
        <WizardPreviewStep
          key={`${draft.parserId}:${draft.revision}`}
          domain={domain}
          draft={draft}
          kind={kind}
          answer={answer}
          pairs={pairs}
          selectedReceiptIds={tradeIds}
          canReviseWithAi={canReviseWithAi}
          onBackToAi={() => setStep('generate')}
          onBackToSamples={() => setStep('samples')}
          onAccepted={onFinished}
          onClose={onClose}
        />
      )}
    </Card>
  );
}
