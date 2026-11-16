'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmailBodyView } from '@/components/email-receipts/EmailBodyView';
import { ReceiptTransactionPicker } from '@/components/email-receipts/ReceiptTransactionPicker';
import type { ChosenTransaction } from '@/components/email-receipts/profile-wizard-types';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptDetail, EmailReceiptListItem } from '@/types/email-receipts';

const logger = createLogger('WizardSampleDialogs');

type DetailState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: EmailReceiptDetail };

/** The content of one stored email, read-only: HTML, text and numbered lines, as the Emails tab shows it. */
function SampleEmailPanel({ receipt }: { receipt: EmailReceiptListItem }) {
  const t = useTranslations('emailReceipts.profileWizard.samples');
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .get(receipt.id)
      .then((detail) => {
        if (!cancelled) setState({ status: 'ready', detail });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [receipt.id, attempt]);

  if (state.status === 'loading') return <LoadingSpinner text={t('emailLoading')} />;
  if (state.status === 'error') {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-red-600 dark:text-red-400">{t('emailError')}</p>
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
    );
  }
  return <EmailBodyView bodyText={state.detail.bodyText} bodyHtml={state.detail.bodyHtml ?? null} lines={state.detail.lines} />;
}

interface SampleDialogProps {
  receipt: EmailReceiptListItem;
  /** The wizard's domain: the transaction search starts with it. */
  domain: string;
  onClose: () => void;
  onChosen: (chosen: Pick<ChosenTransaction, 'transactionId' | 'summary'>) => void;
}

/**
 * One dialog for one sample email: the transaction picker above the stored
 * email, read-only. Choosing a transaction hands the pair to the wizard (kept
 * there, written nowhere) and the caller closes the dialog.
 */
export function SampleDialog({ receipt, domain, onClose, onChosen }: SampleDialogProps) {
  const t = useTranslations('emailReceipts.profileWizard.samples');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const tp = useTranslations('emailReceipts.picker');
  const tc = useTranslations('common');

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="6xl"
      padding="md"
      title={t('dialogTitle', { subject: receipt.subject })}
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="min-w-0">
          <ReceiptTransactionPicker
            effectiveDate={receipt.effectiveDate}
            linkingId={null}
            mode="sample"
            initialSearch={domain}
            onChoose={(row) =>
              onChosen({
                transactionId: row.id,
                summary: tp('row', {
                  date: formatDate(row.transactionDate),
                  amount: formatCurrency(Number(row.amount), row.currencyCode),
                  payee: row.payeeName ?? tp('noPayee'),
                }),
              })
            }
            onLink={() => {}}
          />
        </div>
        <section aria-labelledby="wizard-sample-email-heading" className="min-w-0 space-y-2">
          <h3 id="wizard-sample-email-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('emailHeading')}
          </h3>
          <SampleEmailPanel receipt={receipt} />
        </section>
      </div>
    </Modal>
  );
}
