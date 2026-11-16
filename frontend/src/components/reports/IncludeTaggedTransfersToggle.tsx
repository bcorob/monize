'use client';

import { useTranslations } from 'next-intl';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

interface IncludeTaggedTransfersToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * The opt-in switch for the Balance view (`docs/specs/report-tag-key-breakdown.md`
 * sections 10.7 and 10.9): the tagged flows are drawn on top of the income and
 * expense bars, and Savings (Cash Flow: Net) gives way to Balance and Balance %.
 * The caller renders it only while a tagged series exists, and persists the
 * choice. Income, expenses and net are the server's values in either position
 * (INV-REPORT-003).
 */
export function IncludeTaggedTransfersToggle({ checked, onChange }: IncludeTaggedTransfersToggleProps) {
  const t = useTranslations('reports');
  const label = t('tagBreakdown.includeTransfers');
  return (
    <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <ToggleSwitch checked={checked} onChange={onChange} label={label} size="sm" />
      <span>{label}</span>
    </div>
  );
}
