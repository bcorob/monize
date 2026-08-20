'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { StatusCellButton } from '@/components/transactions/StatusCellButton';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { useDateFormat } from '@/hooks/useDateFormat';
import type { SortDirection } from '@/hooks/useSortableTable';
import { classifyStaleRow, type StaleUnreconciledReason } from '@/lib/stale-reconciliation';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import {
  groupReconcileRows,
  sortReconcileRows,
  type ReconcileSortField,
} from './reconcile-rows';

interface ReconcileTableProps {
  transactions: Transaction[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  sortField: ReconcileSortField;
  sortDirection: SortDirection;
  onSort: (field: ReconcileSortField) => void;
  groupByFlow: boolean;
  /** Account's last reconciled date; null when it has never been reconciled. */
  lastReconciledDate: string | null;
  /** Server-chosen date a row must precede to count as overdue. */
  overdueBefore: string;
  formatCurrency: (amount: number | string | null | undefined) => string;
  onEdit: (transaction: Transaction) => void;
  onDelete: (transaction: Transaction) => void;
  onCycleStatus: (transaction: Transaction) => void;
  /** True while the strict reconciled lock is on, which hides the row actions. */
  reconciledLocked: boolean;
}

const STALE_ROW_CLASS =
  'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30';

/**
 * The reconcile step's transaction table.
 *
 * Every column sorts, the rows optionally group by which side of the ledger
 * they are on, and each row carries the same edit/delete actions the register
 * does -- reconciling is where a missing or wrong transaction is discovered, so
 * making the user leave the screen to fix one is the thing this replaces.
 *
 * Rows the account should already have reconciled are highlighted through the
 * shared `classifyStaleRow`, against the dates the server supplied, so the
 * highlight here and the count in the header badge always mean the same thing.
 */
export function ReconcileTable({
  transactions,
  selectedIds,
  onToggle,
  sortField,
  sortDirection,
  onSort,
  groupByFlow,
  lastReconciledDate,
  overdueBefore,
  formatCurrency,
  onEdit,
  onDelete,
  onCycleStatus,
  reconciledLocked,
}: ReconcileTableProps) {
  const t = useTranslations('reconcile');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  // Blank-payee transfer legs resolve "Transfer to/from <account>" at render
  // time (issue #1214); the sort below is handed the same resolver so the
  // Payee column orders by exactly the text it shows.
  const payeeDisplay = usePayeeDisplay();

  const groups = useMemo(
    () =>
      groupReconcileRows(
        sortReconcileRows(transactions, sortField, sortDirection, payeeDisplay),
        groupByFlow,
      ),
    [transactions, sortField, sortDirection, groupByFlow, payeeDisplay],
  );

  const staleByRow = useMemo(() => {
    const map = new Map<string, StaleUnreconciledReason>();
    for (const transaction of transactions) {
      const reason = classifyStaleRow(
        transaction.status,
        transaction.transactionDate,
        lastReconciledDate,
        overdueBefore,
      );
      if (reason) map.set(transaction.id, reason);
    }
    return map;
  }, [transactions, lastReconciledDate, overdueBefore]);

  const buildActions = (transaction: Transaction): RowAction[] => [
    {
      key: 'edit',
      label: tc('actions.edit'),
      icon: 'edit',
      tone: 'primary',
      onClick: () => onEdit(transaction),
    },
    {
      key: 'delete',
      label: tc('actions.delete'),
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => onDelete(transaction),
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-10">
              <span className="sr-only">{t('list.colSelect')}</span>
            </th>
            <SortableHeader
              field="date"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colDate')}
            </SortableHeader>
            <SortableHeader
              field="payee"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colPayee')}
            </SortableHeader>
            <SortableHeader
              field="category"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colCategory')}
            </SortableHeader>
            <SortableHeader
              field="amount"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              align="right"
              className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colAmount')}
            </SortableHeader>
            <SortableHeader
              field="status"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={onSort}
              align="center"
              className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
            >
              {t('list.colStatus')}
            </SortableHeader>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
              <span className="sr-only">{t('list.colActions')}</span>
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody
            key={group.flow ?? 'all'}
            className="divide-y divide-gray-200 dark:divide-gray-700"
          >
            {group.flow && (
              <tr className="bg-gray-100 dark:bg-gray-700/60">
                <th
                  colSpan={4}
                  scope="colgroup"
                  className="px-4 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase"
                >
                  {group.flow === 'credit'
                    ? t('list.groupCredits', { count: group.rows.length })
                    : t('list.groupDebits', { count: group.rows.length })}
                </th>
                <td className="px-4 py-2 text-right text-xs font-semibold text-gray-600 dark:text-gray-300">
                  {t('list.groupSubtotal', {
                    amount: formatCurrency(group.subtotal),
                  })}
                </td>
                <td colSpan={2} />
              </tr>
            )}
            {group.rows.map((transaction) => {
              const staleReason = staleByRow.get(transaction.id);
              const isSelected = selectedIds.has(transaction.id);
              return (
                <tr
                  key={transaction.id}
                  data-testid={`reconcile-row-${transaction.id}`}
                  data-stale={staleReason ?? undefined}
                  className={`cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : staleReason
                        ? STALE_ROW_CLASS
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                  }`}
                  onClick={() => onToggle(transaction.id)}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(transaction.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={t('list.selectRow', {
                        payee: payeeDisplay(transaction) || '',
                      })}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      {formatDate(transaction.transactionDate)}
                      {staleReason && (
                        <span
                          className="inline-flex items-center rounded-full bg-amber-200 dark:bg-amber-800 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-100"
                          title={
                            staleReason === 'missed'
                              ? t('stale.missedTooltip')
                              : t('stale.overdueTooltip')
                          }
                        >
                          {staleReason === 'missed'
                            ? t('stale.missedChip')
                            : t('stale.overdueChip')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    {payeeDisplay(transaction) || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {transaction.category?.name || '-'}
                  </td>
                  <td
                    className={`px-4 py-3 text-sm text-right whitespace-nowrap font-medium ${
                      Number(transaction.amount) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {formatCurrency(Number(transaction.amount))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusCellButton
                      status={transaction.status}
                      dense
                      onCycle={() => onCycleStatus(transaction)}
                    />
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {transaction.status === TransactionStatus.RECONCILED &&
                    reconciledLocked ? (
                      <span className="block text-right text-xs text-gray-400 dark:text-gray-500">
                        {t('list.lockedRow')}
                      </span>
                    ) : (
                      <RowActions
                        actions={buildActions(transaction)}
                        density="compact"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
