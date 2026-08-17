'use client';

import { useTranslations } from 'next-intl';
import { TransactionStatus } from '@/types/transaction';

interface StatusCellButtonProps {
  status: TransactionStatus;
  dense: boolean;
  onCycle: () => void;
}

/**
 * The one status cell: a click-to-cycle button showing the coloured status
 * label (single letters in dense mode). Used by the cash register's rows and
 * the investment register's rows -- do not hand-roll a second one; the
 * ui-conventions test fails on the dense-label keys appearing anywhere else.
 * Strings live in the `transactions` catalog whichever register mounts it.
 */
export function StatusCellButton({
  status,
  dense,
  onCycle,
}: StatusCellButtonProps) {
  const t = useTranslations('transactions');
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onCycle();
      }}
      className="text-sm px-3 py-1.5 -my-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      title={t('list.status.cycleTitle')}
    >
      {status === TransactionStatus.RECONCILED ? (
        <span className="text-blue-600 dark:text-blue-400">
          {dense ? t('list.status.reconciledDense') : t('list.status.reconciled')}
        </span>
      ) : status === TransactionStatus.CLEARED ? (
        <span className="text-green-600 dark:text-green-400">
          {dense ? t('list.status.clearedDense') : t('list.status.cleared')}
        </span>
      ) : status === TransactionStatus.VOID ? (
        <span className="text-red-600 dark:text-red-400">
          {dense ? t('list.status.voidDense') : t('list.status.void').toUpperCase()}
        </span>
      ) : (
        <span className="text-gray-400 dark:text-gray-500">
          {dense ? t('list.status.pendingDense') : t('list.status.pending')}
        </span>
      )}
    </button>
  );
}
