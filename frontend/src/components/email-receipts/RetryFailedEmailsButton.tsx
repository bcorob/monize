'use client';

import { useTranslations } from 'next-intl';
import { ProcessStatus } from '@/components/email-receipts/ProcessStatus';
import { Button } from '@/components/ui/Button';
import { useProcessStoredEmails } from '@/hooks/useProcessStoredEmails';

interface RetryFailedEmailsButtonProps {
  /** How many stored emails could not be read (`parse_failed`); the caller draws the button only while it is above zero. */
  count: number;
  /** Keep the run to this sender domain (and its sub-domains); omit for every sender. */
  domain?: string;
  /** Called once a run has ended, so the list and the counts are read again. */
  onFinished?: () => void;
  className?: string;
}

/**
 * "Retry failed emails (N)": runs the server's bulk call over the emails in the
 * `parse_failed` state only, in a loop with progress and a Cancel. Everything else
 * is read by the poll and by approving a profile, so this is the one manual run
 * left on the Emails tab, and it exists only while there is something to retry.
 */
export function RetryFailedEmailsButton({ count, domain, onFinished, className }: RetryFailedEmailsButtonProps) {
  const t = useTranslations('emailReceipts.process');
  const { state, run, cancel, dismiss } = useProcessStoredEmails();
  const running = state.status === 'running';

  const start = async () => {
    await run([domain], ['parse_failed']);
    onFinished?.();
  };

  return (
    <div className={`space-y-3 ${className ?? ''}`}>
      <Button variant="outline" onClick={() => void start()} disabled={running}>
        {t('retryFailed', { count })}
      </Button>
      <ProcessStatus state={state} onCancel={cancel} onDismiss={dismiss} />
    </div>
  );
}
