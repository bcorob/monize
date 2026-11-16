'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { TransactionRule } from '@/types/transaction-rule';

const logger = createLogger('PaymentMatchingCreateModal');

/** Length of a pattern the server accepts (`MAX_PAYMENT_MATCHING_PATTERN_LENGTH`). */
const MAX_PATTERN_LENGTH = 200;

interface PaymentMatchingCreateModalProps {
  loanAccountId: string;
  /** Prefills the payee pattern as `*<institution>*`. */
  institution: string | null;
  /** The schedule's source account, the one the rule matches debits in. */
  sourceAccountName: string | null;
  onClose: () => void;
  onCreated: (rule: TransactionRule) => void;
}

/**
 * "Create one": the payee and description globs of the loan's
 * payment-matching rule, posted to `POST /accounts/:id/payment-matching-rule`
 * (`docs/specs/loan-installment-settlement.md` decision 5). The source
 * account is the schedule's, never chosen here; the server also turns the
 * bill's auto-post off.
 */
export function PaymentMatchingCreateModal({
  loanAccountId,
  institution,
  sourceAccountName,
  onClose,
  onCreated,
}: PaymentMatchingCreateModalProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const [payeePattern, setPayeePattern] = useState(institution ? `*${institution}*` : '');
  const [descriptionPattern, setDescriptionPattern] = useState('');
  const [payeeError, setPayeeError] = useState<string | undefined>(undefined);
  const [descriptionError, setDescriptionError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payee = payeePattern.trim();
    const description = descriptionPattern.trim();
    const nextPayeeError = payee.includes('*') ? undefined : t('loanDetail.paymentMatching.create.payeePatternRequired');
    const nextDescriptionError =
      description === '' || description.includes('*')
        ? undefined
        : t('loanDetail.paymentMatching.create.descriptionPatternWildcard');
    setPayeeError(nextPayeeError);
    setDescriptionError(nextDescriptionError);
    if (nextPayeeError || nextDescriptionError) return;

    setSaving(true);
    setFailure(null);
    try {
      const rule = await accountsApi.createPaymentMatchingRule(loanAccountId, {
        payeePattern: payee,
        descriptionPattern: description || undefined,
      });
      onCreated(rule);
    } catch (error) {
      logger.error(error);
      setFailure(getErrorMessage(error, t('loanDetail.paymentMatching.create.failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={saving ? undefined : onClose}
      title={t('loanDetail.paymentMatching.create.title')}
      description={
        sourceAccountName
          ? t('loanDetail.paymentMatching.create.descriptionWithAccount', { account: sourceAccountName })
          : t('loanDetail.paymentMatching.create.description')
      }
      padding="md"
      maxWidth="lg"
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <Input
          label={t('paymentMatching.payeePattern')}
          placeholder={t('paymentMatching.payeePatternPlaceholder')}
          value={payeePattern}
          maxLength={MAX_PATTERN_LENGTH}
          onChange={(event) => setPayeePattern(event.target.value)}
          error={payeeError}
        />
        <Input
          label={t('paymentMatching.descriptionPattern')}
          placeholder={t('paymentMatching.descriptionPatternPlaceholder')}
          value={descriptionPattern}
          maxLength={MAX_PATTERN_LENGTH}
          onChange={(event) => setDescriptionPattern(event.target.value)}
          error={descriptionError}
        />
        {failure && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </Button>
          <Button type="submit" isLoading={saving} disabled={saving}>
            {t('loanDetail.paymentMatching.create.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
