'use client';

import { useTranslations } from 'next-intl';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

/**
 * Which of an investment account's two ledgers a register is showing: the
 * brokerage's trades, or the cash account's ordinary transactions.
 */
export type InvestmentTransactionView = 'brokerage' | 'cash';

interface InvestmentViewToggleProps {
  value: InvestmentTransactionView;
  onChange: (view: InvestmentTransactionView) => void;
}

/**
 * The segmented control that switches an investment register between the
 * brokerage and cash ledgers.
 *
 * An investment account is one account with two ledgers, so every surface
 * showing its register offers the same switch. Rendering it from one component
 * is what keeps the two reading as the same control -- both call sites
 * previously hardcoded which half was active, so the styling had to be kept in
 * step by hand.
 */
export function InvestmentViewToggle({
  value,
  onChange,
}: InvestmentViewToggleProps) {
  const t = useTranslations('investments');

  return (
    <div className={SEGMENTED_GROUP_CLASS}>
      <button
        onClick={() => onChange('brokerage')}
        aria-pressed={value === 'brokerage'}
        className={segmentClass(value === 'brokerage')}
      >
        {t('page.brokerageTab')}
      </button>
      <button
        onClick={() => onChange('cash')}
        aria-pressed={value === 'cash'}
        className={segmentClass(value === 'cash')}
      >
        {t('page.cashTab')}
      </button>
    </div>
  );
}
