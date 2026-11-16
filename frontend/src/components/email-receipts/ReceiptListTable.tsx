'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ReceiptStateBadge } from '@/components/email-receipts/ReceiptStateBadge';
import { SelectAllCheckbox } from '@/components/email-receipts/SelectAllCheckbox';
import { useBookedTradeSummary } from '@/components/email-receipts/useBookedTradeSummary';
import { Badge } from '@/components/ui/Badge';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { RowActions, type RowAction } from '@/components/ui/row-actions';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import type { EmailReceiptListItem } from '@/types/email-receipts';

const CHECKBOX_CLASS =
  'h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600';

interface ReceiptListTableProps {
  items: readonly EmailReceiptListItem[];
  isChecked: (receipt: EmailReceiptListItem) => boolean;
  allSelected: boolean;
  someSelected: boolean;
  /** Ticking waits while a draft or a bulk action runs. */
  selectionDisabled: boolean;
  onToggle: (receipt: EmailReceiptListItem) => void;
  onToggleAll: () => void;
  actionsFor: (receipt: EmailReceiptListItem) => RowAction[];
}

/**
 * One page of the receipts list. The order is the server's (newest first, paged), so no column sorts: a sort of one
 * page would rank fifty emails out of thousands. Density is the list's own (`emailReceipts`); on a phone at Normal
 * density each email is one card cell (Model B), carrying the transaction the tier table hides below `sm`; Compact
 * and Dense keep the table, and so does every wider screen.
 */
export function ReceiptListTable({
  items,
  isChecked,
  allSelected,
  someSelected,
  selectionDisabled,
  onToggle,
  onToggleAll,
  actionsFor,
}: ReceiptListTableProps) {
  const t = useTranslations('emailReceipts.receipts');
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const bookedTradeSummary = useBookedTradeSummary();
  const { density } = useDensityPreference('emailReceipts');
  const { cellPadding, headerPadding } = useTableDensity(density);
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  const selectAll = (
    <SelectAllCheckbox
      checked={allSelected}
      indeterminate={someSelected}
      disabled={selectionDisabled}
      label={t('selection.selectAll')}
      onChange={onToggleAll}
    />
  );

  return (
    <div>
      <DensityToggleBar view="emailReceipts" />
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            {wrapped ? (
              <tr>
                <Th className={`${headerPadding} w-8`}>{selectAll}</Th>
                <Th className={headerPadding}>{t('columns.email')}</Th>
              </tr>
            ) : (
              <tr>
                <Th className={`${headerPadding} w-8`}>{selectAll}</Th>
                <Th className={headerPadding}>{t('columns.date')}</Th>
                <Th className={headerPadding}>{t('columns.email')}</Th>
                <Th className={`${headerPadding} hidden sm:table-cell`}>{t('columns.transaction')}</Th>
                <Th className={headerPadding}>{t('columns.state')}</Th>
                <Th align="right" className={headerPadding}>
                  {t('columns.actions')}
                </Th>
              </tr>
            )}
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {items.map((receipt) => {
              // A trade email accounts for an investment transaction, never a bank one.
              const booked = receipt.isTrade ? (receipt.investmentTransaction ?? null) : null;
              const summary = booked
                ? bookedTradeSummary(booked)
                : receipt.transaction && !receipt.isTrade
                  ? t('transactionSummary', {
                      date: formatDate(receipt.transaction.date),
                      amount: formatCurrency(receipt.transaction.amount, receipt.transaction.currencyCode),
                      payee: receipt.transaction.payeeName ?? t('noPayee'),
                    })
                  : null;
              const summaryHref = booked
                ? `/investments?edit=${booked.id}`
                : receipt.transaction
                  ? `/transactions?targetTransactionId=${receipt.transaction.id}`
                  : null;
              const checkbox = (
                <input
                  type="checkbox"
                  checked={isChecked(receipt)}
                  disabled={selectionDisabled}
                  onChange={() => onToggle(receipt)}
                  aria-label={t('selection.select', { subject: receipt.subject })}
                  className={CHECKBOX_CLASS}
                />
              );
              const identity = (
                <>
                  <div className="font-medium">
                    {receipt.subject}
                    {receipt.isTrade && (
                      <>
                        {' '}
                        <Badge variant="blue" className="align-middle">
                          {t('tradeBadge')}
                        </Badge>
                      </>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{receipt.fromAddress}</div>
                </>
              );
              const transaction =
                summary && summaryHref ? (
                  <Link href={summaryHref} className="text-blue-600 hover:underline dark:text-blue-400">
                    {summary}
                  </Link>
                ) : (
                  <span className="text-gray-500 dark:text-gray-400">{t('noTransaction')}</span>
                );

              if (wrapped) {
                return (
                  <tr key={receipt.id}>
                    <Td className={`${cellPadding} w-8 align-top`}>{checkbox}</Td>
                    <Td className={`${cellPadding} align-top`}>
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5">
                        <div className="min-w-0 break-words">{identity}</div>
                        <ReceiptStateBadge receipt={receipt} />
                        <div className="col-span-2 text-xs text-gray-500 dark:text-gray-400">
                          {formatDateTime(receipt.effectiveDate)}
                        </div>
                        <div className="col-span-2 min-w-0 break-words text-xs">{transaction}</div>
                        <div className="col-span-2">
                          <RowActions actions={actionsFor(receipt)} density={density} maxInline={3} />
                        </div>
                      </div>
                    </Td>
                  </tr>
                );
              }

              return (
                <tr key={receipt.id}>
                  <Td className={`${cellPadding} align-top`}>{checkbox}</Td>
                  <Td className={`${cellPadding} align-top whitespace-nowrap`}>{formatDateTime(receipt.effectiveDate)}</Td>
                  <Td className={`${cellPadding} min-w-0 align-top break-words`}>
                    {identity}
                    {summary && <div className="mt-1 text-xs text-gray-700 dark:text-gray-300 sm:hidden">{summary}</div>}
                  </Td>
                  <Td className={`${cellPadding} hidden align-top sm:table-cell`}>{transaction}</Td>
                  <Td className={`${cellPadding} align-top`}>
                    <ReceiptStateBadge receipt={receipt} />
                  </Td>
                  <Td align="right" className={`${cellPadding} align-top`}>
                    <RowActions actions={actionsFor(receipt)} density={density} maxInline={3} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
