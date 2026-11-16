'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { ReceiptPartsTable, type ReceiptPartRow } from '@/components/email-receipts/ReceiptPartsTable';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th, Td } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { ParsedReceipt } from '@/types/email-receipts';

interface ParsedReceiptViewProps {
  parsed: ParsedReceipt;
  /** The currency the amounts are shown in; the reader's own when the receipt names none. */
  currencyCode?: string;
  /**
   * Category id to its full label; an id that is not in it is shown as unknown.
   * `null` while the category list has not loaded (or failed): the column then
   * says so instead of calling every category unknown.
   */
  categoryLabels: ReadonlyMap<string, string> | null;
  /** The parts to list instead of `parsed.links` (a test names the component each one found). */
  parts?: readonly ReceiptPartRow[];
}

/**
 * What a parser read from one email: the order id, the stated totals and the
 * line items with their categories, and whether the read is complete.
 *
 * Amounts arrive in 1/10000 units and are converted exactly once
 * (`fromReceiptUnits`) before `formatCurrency`. A figure the email did not
 * state is `null` and renders as "not found", never as a zero that would read
 * as a stated free shipping.
 */
export function ParsedReceiptView({ parsed, currencyCode, categoryLabels, parts: partsOverride }: ParsedReceiptViewProps) {
  const t = useTranslations('emailReceipts.parsed');
  const { formatCurrency } = useNumberFormat();

  const parts = partsOverride ?? parsed.links;

  const money = (units: number | null) =>
    units === null ? (
      <span className="text-gray-500 dark:text-gray-400">{t('notFound')}</span>
    ) : (
      formatCurrency(fromReceiptUnits(units), currencyCode)
    );

  const category = (id: string | null) => {
    if (id === null) return t('noCategory');
    if (categoryLabels === null) return t('categoryUnavailable');
    return categoryLabels.get(id) ?? t('unknownCategory');
  };

  const figures: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'orderId',
      label: t('orderId'),
      value: parsed.orderId ?? <span className="text-gray-500 dark:text-gray-400">{t('notFound')}</span>,
    },
    { key: 'total', label: t('total'), value: money(parsed.total) },
    // Stated only by some emails (a card line after a promotion; a gateway's notice): shown when there is one.
    ...(parsed.paid != null ? [{ key: 'paid', label: t('paid'), value: money(parsed.paid) }] : []),
    { key: 'shipping', label: t('shipping'), value: money(parsed.shipping) },
    { key: 'discount', label: t('discount'), value: money(parsed.discount) },
    ...(parsed.payee ? [{ key: 'payee', label: t('payee'), value: parsed.payee }] : []),
    // What the profile's `reference` field read: the identifier the bank operation should carry.
    ...(parsed.reference ? [{ key: 'reference', label: t('reference'), value: parsed.reference }] : []),
    // A component (a purchase email waiting for its settlement): the key that ties it to one.
    ...(parsed.linkKey ? [{ key: 'linkKey', label: t('linkKey'), value: parsed.linkKey }] : []),
  ];

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {figures.map((figure) => (
          <div key={figure.key}>
            <dt className="text-gray-500 dark:text-gray-400">{figure.label}</dt>
            <dd className="font-medium text-gray-900 dark:text-gray-100">{figure.value}</dd>
          </div>
        ))}
      </dl>

      {parsed.items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('noItems')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <Th className="px-2 sm:px-4">{t('columns.item')}</Th>
                <Th align="right" className="px-2 sm:px-4">
                  {t('columns.qty')}
                </Th>
                <Th align="right" className="px-2 sm:px-4">
                  {t('columns.amount')}
                </Th>
                <Th className="px-2 sm:px-4">{t('columns.category')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {parsed.items.map((item, index) => (
                <tr key={`${index}-${item.name}`}>
                  <Td className="px-2 sm:px-4 break-words">
                    {item.name}
                    {item.instalment ? ` (${item.instalment})` : ''}
                    {/* A joined component's shipping, fee or discount line says what it is. */}
                    {item.kind !== undefined && item.kind !== 'item' && (
                      <Badge variant="gray" className="ml-2">
                        {t(`kinds.${item.kind}`)}
                      </Badge>
                    )}
                  </Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {item.qty}
                  </Td>
                  <Td align="right" className="px-2 sm:px-4 whitespace-nowrap">
                    {/* A discount line holds a non-negative amount that counts against the total. */}
                    {money(item.kind === 'discount' && item.amount !== 0 ? -item.amount : item.amount)}
                  </Td>
                  <Td className="px-2 sm:px-4">
                    {category(item.categoryId)}
                    {/* The AI chose it: said beside the category, so a person reviews it as a suggestion. */}
                    {item.categoryId !== null && item.categorySource === 'ai' && (
                      <Badge variant="purple" className="ml-2">
                        {t('categoryByAi')}
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {parts !== undefined && parts.length > 0 && <ReceiptPartsTable parts={parts} currencyCode={currencyCode} />}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={parsed.complete ? 'green' : 'amber'}>
          {parsed.complete ? t('complete') : t('incomplete')}
        </Badge>
        {!parsed.complete && parsed.reason && (
          <span className="text-gray-700 dark:text-gray-300">{t(`reasons.${parsed.reason}`)}</span>
        )}
        {parsed.source === 'ai' && <Badge variant="blue">{t('readByAi')}</Badge>}
        {parsed.source === 'schema_org' && <Badge variant="blue">{t('readFromStructuredData')}</Badge>}
      </div>
    </div>
  );
}
