'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { WizardDraft } from '@/components/email-receipts/profile-wizard-types';
import { Button } from '@/components/ui/Button';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';

const logger = createLogger('WizardWaitingStep');

/** How often the uncovered-domains list is read while the wizard waits for the agent. */
export const WIZARD_WAIT_POLL_MS = 15_000;

/** The draft the domain had when the wait began; an arrival is a draft that is not this one, or this one at a newer revision. */
export interface WaitingBaseline {
  parserId: string | null;
  /** Null when not known: it is then read once, from the parser itself. */
  revision: number | null;
}

interface WizardWaitingStepProps {
  domain: string;
  baseline: WaitingBaseline;
  /** The agent's draft is in (a new draft or a new revision): the wizard moves to the preview. */
  onArrived: (draft: WizardDraft) => void;
  /** Go back to the samples; sending again replaces the request while no agent has claimed it. */
  onStartOver: () => void;
}

type Wait =
  | { status: 'waiting'; agentWorking: boolean; checkFailed: boolean }
  | { status: 'ended' };

/**
 * The wizard while the user's own agent (the MCP relay) writes the profile: the
 * request is in the AI inbox, nothing here blocks, and the page may be closed. While
 * it stays open the domain's entry in the uncovered list is read every 15 seconds
 * (and on "Check now"). The request leaving `pending`/`claimed` with a draft that is
 * new (another parser, or the same one at a newer revision) moves the wizard on; with
 * no new draft it was dismissed or expired, which is said, never read as an answer.
 */
export function WizardWaitingStep({ domain, baseline, onArrived, onStartOver }: WizardWaitingStepProps) {
  const t = useTranslations('emailReceipts.profileWizard.waiting');
  const [wait, setWait] = useState<Wait>({ status: 'waiting', agentWorking: false, checkFailed: false });
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // The revision the domain's draft had when the wait began, read once.
  const baselineRevision = useRef<Promise<number | null> | null>(null);
  const onArrivedRef = useRef(onArrived);
  useEffect(() => {
    onArrivedRef.current = onArrived;
  }, [onArrived]);

  const readBaselineRevision = useCallback((): Promise<number | null> => {
    if (baselineRevision.current === null) {
      baselineRevision.current =
        baseline.parserId === null || baseline.revision !== null
          ? Promise.resolve(baseline.revision)
          : emailReceiptsApi.parsers
              .get(baseline.parserId)
              .then((parser) => parser.revision)
              .catch((error) => {
                logger.error(error);
                return null;
              });
    }
    return baselineRevision.current;
  }, [baseline.parserId, baseline.revision]);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const known = readBaselineRevision();
      const found = (await emailReceiptsApi.receipts.listUncovered()).find((entry) => entry.domain === domain);
      if (!mounted.current) return;
      if (found?.pendingRequestId) {
        setWait({ status: 'waiting', agentWorking: found.pendingRequestStatus === 'claimed', checkFailed: false });
        return;
      }
      if (!found || found.draftParserId === null) {
        setWait({ status: 'ended' });
        return;
      }
      const parser = await emailReceiptsApi.parsers.get(found.draftParserId);
      const before = await known;
      if (!mounted.current) return;
      const isNew = parser.id !== baseline.parserId || (before !== null && parser.revision > before);
      if (isNew) onArrivedRef.current({ parserId: parser.id, revision: parser.revision });
      else setWait({ status: 'ended' });
    } catch (error) {
      logger.error(error);
      if (mounted.current) setWait((current) => (current.status === 'waiting' ? { ...current, checkFailed: true } : current));
    } finally {
      inFlight.current = false;
    }
  }, [domain, baseline.parserId, readBaselineRevision]);

  useEffect(() => {
    mounted.current = true;
    // The baseline's revision is read now, before the agent can change the draft.
    void readBaselineRevision();
    const handle = setInterval(() => void check(), WIZARD_WAIT_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(handle);
    };
  }, [check, readBaselineRevision]);

  const checkNow = async () => {
    setChecking(true);
    await check();
    if (mounted.current) setChecking(false);
  };

  if (wait.status === 'ended') {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
          {t('ended')}
        </p>
        <Button onClick={onStartOver}>{t('startOver')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div role="status" className="space-y-1 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-100">
        <p className="font-medium">{t('heading')}</p>
        <p>{t('body')}</p>
        {wait.agentWorking && <p>{t('working')}</p>}
        <p className="text-xs">{t('polling', { seconds: WIZARD_WAIT_POLL_MS / 1000 })}</p>
      </div>
      {wait.checkFailed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('checkFailed')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/ai-reviews" className="text-sm font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400">
          {t('inboxLink')}
        </Link>
        <Button variant="outline" isLoading={checking} disabled={checking} onClick={() => void checkNow()}>
          {t('checkNow')}
        </Button>
        <Button variant="outline" onClick={onStartOver}>
          {t('startOver')}
        </Button>
      </div>
    </div>
  );
}
