'use client';

import { useTranslations } from 'next-intl';
import {
  RECEIPT_TRACE_FIELDS,
  RECEIPT_TRADE_TRACE_FIELDS,
  type ReceiptTrace,
  type ReceiptTradeTrace,
  type ReceiptTraceHit,
  type ReceiptTraceItem,
} from '@/types/email-receipts';

interface ParserTraceListProps {
  /** A receipt profile's trace, or a trade profile's (which has no items). */
  trace: ReceiptTrace | ReceiptTradeTrace;
}

/** The pattern that read line `index` of an item: a record has one per consumed line, the others one for all. */
const patternFor = (item: ReceiptTraceItem, index: number): string =>
  item.patterns[item.mode === 'record' ? index : 0] ?? '';

/**
 * Which entry and which line read each value of a test, as a compact list: the
 * field, the entry index and glob, and the line number and text that produced
 * it (a labelled entry names its label line too; a multi-line pattern lists
 * every line it matched), then each item's lines. A field that read nothing is
 * not listed. Every text is shown as text, never as markup.
 */
export function ParserTraceList({ trace }: ParserTraceListProps) {
  const t = useTranslations('emailReceipts.test.matchedBy');

  const hit = (field: string, value: ReceiptTraceHit) => (
    <li key={field}>
      <span className="font-medium text-gray-900 dark:text-gray-100">{t(`fields.${field}`)}</span>{' '}
      {value.labelLine !== undefined ? (
        <span>
          {t('labelled', {
            entry: value.entry + 1,
            label: value.label ?? '',
            labelLine: value.labelLine.line,
            labelText: value.labelLine.text,
            pattern: value.pattern,
            line: value.line.line,
            text: value.line.text,
          })}
        </span>
      ) : value.line.line === 0 ? (
        <span>{t('entrySubject', { entry: value.entry + 1, pattern: value.pattern, text: value.line.text })}</span>
      ) : value.lines !== undefined && value.lines.length > 1 ? (
        <>
          <span>
            {t('entryLines', {
              entry: value.entry + 1,
              pattern: value.pattern,
              first: value.lines[0].line,
              last: value.lines[value.lines.length - 1].line,
            })}
          </span>
          <ul className="ml-4 list-disc">
            {value.lines.map((line) => (
              <li key={`${field}-${line.line}`}>{t('blockLine', { line: line.line, text: line.text })}</li>
            ))}
          </ul>
        </>
      ) : (
        <span>{t('entryLine', { entry: value.entry + 1, pattern: value.pattern, line: value.line.line, text: value.line.text })}</span>
      )}
    </li>
  );

  const isReceipt = 'items' in trace;
  const items: ReceiptTraceItem[] = isReceipt ? trace.items : [];
  const fields: readonly string[] = isReceipt ? RECEIPT_TRACE_FIELDS : RECEIPT_TRADE_TRACE_FIELDS;
  const hits = fields.flatMap((field) => {
    const value = (trace as Record<string, ReceiptTraceHit | null | undefined>)[field];
    // A server that predates a field sends none: nothing was read, as for null.
    return !value ? [] : [hit(field, value)];
  });

  return (
    <div className="text-xs text-gray-600 dark:text-gray-400">
      <p className="font-medium text-gray-900 dark:text-gray-100">{t('heading')}</p>
      {hits.length === 0 && items.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <ul className="mt-1 space-y-1 break-words font-mono">
          {hits}
          {items.map((item, number) => (
            <li key={`item-${number}`}>
              <span className="font-medium text-gray-900 dark:text-gray-100">{t('item', { number: number + 1 })}</span>
              <ul className="ml-4 list-disc">
                {item.lines.map((line, index) => (
                  <li key={`${number}-${line.line}`}>
                    {t('itemLine', { pattern: patternFor(item, index), line: line.line, text: line.text })}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
