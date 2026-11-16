'use client';

import { useTranslations } from 'next-intl';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th, Td } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { SchemaOrgOrder } from '@/types/email-receipts';

interface StructuredOrderViewProps {
  /** The schema.org order the email carries, or `null` when it has none. */
  order: SchemaOrgOrder | null;
}

/**
 * Whether the email carries an order as structured data (schema.org JSON-LD or
 * microdata) and, when it does, what that order says. The pipeline reads it only
 * when no parser applies or the parser found no total, so this is how a person
 * sees what it would read. Amounts arrive in 1/10000 units and are converted once
 * (`fromReceiptUnits`); a figure the markup did not state is shown as not found,
 * never as zero. The markup's currency is shown beside the figures, not applied.
 */
export function StructuredOrderView({ order }: StructuredOrderViewProps) {
  const t = useTranslations('emailReceipts.detail.structured');
  const tp = useTranslations('emailReceipts.parsed');
  const { formatCurrency } = useNumberFormat();

  if (order === null) {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        <span className="font-medium">{t('notFound')}</span> <span className="text-gray-500 dark:text-gray-400">{t('notFoundHelp')}</span>
      </p>
    );
  }

  const notFound = <span className="text-gray-500 dark:text-gray-400">{tp('notFound')}</span>;
  const money = (units: number | null) => (units === null ? notFound : formatCurrency(fromReceiptUnits(units), order.currency ?? undefined));
  const figures = [
    { key: 'orderNumber', label: tp('orderId'), value: order.orderNumber ?? notFound },
    { key: 'seller', label: t('seller'), value: order.seller ?? notFound },
    { key: 'total', label: tp('total'), value: money(order.total) },
    { key: 'discount', label: tp('discount'), value: money(order.discount) },
    ...(order.currency ? [{ key: 'currency', label: t('currency'), value: order.currency }] : []),
    ...(order.orderDate ? [{ key: 'orderDate', label: t('orderDate'), value: order.orderDate }] : []),
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('found')}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.key} className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{figure.label}</dt>
            <dd className="break-words font-medium text-gray-900 dark:text-gray-100">{figure.value}</dd>
          </div>
        ))}
      </dl>
      {order.items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{tp('noItems')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th className="px-2 sm:px-4">{tp('columns.item')}</Th>
                <Th align="right" className="px-2 sm:px-4">
                  {tp('columns.qty')}
                </Th>
                <Th align="right" className="px-2 sm:px-4">
                  {t('unitPrice')}
                </Th>
                <Th align="right" className="px-2 sm:px-4">
                  {tp('columns.amount')}
                </Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {order.items.map((item, index) => (
                <tr key={`${index}-${item.name}`}>
                  <Td className="px-2 sm:px-4 break-words">{item.name}</Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {item.qty}
                  </Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {money(item.unitPrice)}
                  </Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {money(item.amount)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
