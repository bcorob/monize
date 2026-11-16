'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import type { Transaction } from '@/types/transaction';

/**
 * Whether a register row carries a warranty. `warrantyCount` is the server's
 * count of the row's unarchived warranties; it is absent on a surface whose
 * endpoint does not count them, which offers no warranty affordance either, so
 * absent and zero both read as "none" here and nowhere else.
 */
export function rowHasWarranties(transaction: Pick<Transaction, 'warrantyCount'>): boolean {
  return transaction.warrantyCount !== undefined && transaction.warrantyCount > 0;
}

/**
 * The shield and count a row with warranties shows, beside the paperclip: in
 * the tier table's Attachments cell and on the phone card alike, so the two
 * cannot drift. The caller decides whether the row has any to show.
 */
export function WarrantyBadge({ count }: { count: number }) {
  const t = useTranslations('transactions');
  const label = t('list.warrantiesCount', { count });
  return (
    <span
      data-testid="warranty-badge"
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300"
    >
      <ShieldCheckIcon className="w-3.5 h-3.5" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
    </span>
  );
}
