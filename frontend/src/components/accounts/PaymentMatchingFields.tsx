'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

interface PaymentMatchingFieldsProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  payeePattern: string;
  onPayeePatternChange: (value: string) => void;
  payeePatternError?: string;
  descriptionPattern: string;
  onDescriptionPatternChange: (value: string) => void;
  descriptionPatternError?: string;
  /** The schedule's source account, named once the switch is on. */
  sourceAccountName?: string;
  /** Names the account in the switch label ("this mortgage" / "this loan"). */
  kind: 'mortgage' | 'loan';
}

/**
 * "Payment matching": the rule that settles the bank's own debit of a loan or
 * mortgage payment against each installment instead of posting the bill
 * separately (docs/specs/loan-installment-settlement.md decision 5). Shared
 * by the mortgage form (create only) and the loan-payment setup dialog, so
 * the switch, the two glob inputs and their copy exist once.
 */
export function PaymentMatchingFields({
  enabled,
  onToggle,
  payeePattern,
  onPayeePatternChange,
  payeePatternError,
  descriptionPattern,
  onDescriptionPatternChange,
  descriptionPatternError,
  sourceAccountName,
  kind,
}: PaymentMatchingFieldsProps) {
  const t = useTranslations('accounts');
  const toggleLabel = t('paymentMatching.toggleLabel', { kind });

  return (
    <div className="space-y-3 p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <ToggleSwitch checked={enabled} onChange={onToggle} label={toggleLabel} />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {toggleLabel}
        </span>
        <InfoTooltip text={t('paymentMatching.toggleHelp')} placement="top" usePortal />
      </div>
      {enabled && (
        <div className="space-y-3 pl-1">
          <Input
            label={t('paymentMatching.payeePattern')}
            placeholder={t('paymentMatching.payeePatternPlaceholder')}
            value={payeePattern}
            onChange={(e) => onPayeePatternChange(e.target.value)}
            error={payeePatternError}
          />
          <Input
            label={t('paymentMatching.descriptionPattern')}
            placeholder={t('paymentMatching.descriptionPatternPlaceholder')}
            value={descriptionPattern}
            onChange={(e) => onDescriptionPatternChange(e.target.value)}
            error={descriptionPatternError}
          />
          {sourceAccountName && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('paymentMatching.fromAccount', { account: sourceAccountName })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
