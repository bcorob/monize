'use client';

import { useTranslations } from 'next-intl';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th, Td } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { ParsedReceiptReason, ReceiptLinkOutcome } from '@/types/email-receipts';

/** One part of a settlement as a reading or a test reports it. Amounts are in 1/10000 units. */
export interface ReceiptPartRow {
  partIndex: number;
  /** The part's link value; null when it captured none. */
  link: string | null;
  partAmount: number;
  outcome: ReceiptLinkOutcome;
  /** The component's net; absent or null when there is no complete component to measure. */
  componentNet?: number | null;
  /** What other settlements already took from the component. */
  taken?: number | null;
  componentReason?: ParsedReceiptReason | null;
  /** The component the link found, when the report names it (a test does). `effectiveDate` is `YYYY-MM-DD`. */
  component?: { subject: string; effectiveDate: string; profileName: string | null } | null;
}

interface ReceiptPartsTableProps {
  parts: readonly ReceiptPartRow[];
  /** The currency the amounts are shown in; the reader's own when the receipt names none. */
  currencyCode?: string;
}

/** The parts of a settlement: each one's link, amount and what the join did with it. */
export function ReceiptPartsTable({ parts, currencyCode }: ReceiptPartsTableProps) {
  const t = useTranslations('emailReceipts.parsed');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const money = (units: number) => formatCurrency(fromReceiptUnits(units), currencyCode);

  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('parts.heading')}</h4>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th className="px-2 sm:px-4">{t('parts.part')}</Th>
              <Th className="px-2 sm:px-4">{t('parts.link')}</Th>
              <Th align="right" className="px-2 sm:px-4">
                {t('columns.amount')}
              </Th>
              <Th className="px-2 sm:px-4">{t('parts.outcome')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {parts.map((report) => (
              <tr key={report.partIndex}>
                <Td className="px-2 sm:px-4 whitespace-nowrap">{report.partIndex + 1}</Td>
                <Td className="px-2 sm:px-4 break-words">
                  {report.link ?? <span className="text-gray-500 dark:text-gray-400">{t('parts.noLink')}</span>}
                </Td>
                <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                  {money(report.partAmount)}
                </Td>
                <Td className="px-2 sm:px-4">
                  <div>{t(`linkOutcomes.${report.outcome}`)}</div>
                  {report.component != null && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 break-words">
                      {t('parts.component', { subject: report.component.subject, date: formatDate(report.component.effectiveDate) })}
                      {report.component.profileName !== null &&
                        ` ${t('parts.componentProfile', { name: report.component.profileName })}`}
                    </div>
                  )}
                  {report.componentNet != null && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('parts.componentNet', { amount: money(report.componentNet) })}
                      {report.taken != null && ` ${t('parts.taken', { amount: money(report.taken) })}`}
                    </div>
                  )}
                  {report.componentReason != null && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t(`reasons.${report.componentReason}`)}</div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
