'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import type { EmailReceiptLines, ReceiptLinesSource } from '@/types/email-receipts';

/** The server reads at most this many lines of an email (`MAX_PARSE_LINES`). */
const MAX_PARSE_LINES = 2000;

interface EmailLinesViewProps {
  lines: EmailReceiptLines;
}

/**
 * The numbered lines a parser's patterns are matched against, per source, so a
 * person writing a pattern sees exactly what it meets: the numbers are the ones
 * a test's "Matched by" list gives. The lines are plain text in this page, never
 * markup: whatever the email contained is characters here.
 *
 * `html` is `null` when the email has no HTML part; its button is then
 * unavailable and the view says why, and a parser that reads HTML cannot read
 * the email.
 */
export function EmailLinesView({ lines }: EmailLinesViewProps) {
  const t = useTranslations('emailReceipts.detail.lines');
  const [source, setSource] = useState<ReceiptLinesSource>('text');

  const shown = source === 'html' && lines.html === null ? 'text' : source;
  const list = shown === 'html' ? (lines.html ?? []) : lines.text;
  const buttons: ReceiptLinesSource[] = ['text', 'html'];

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('help')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('sourceLabel')} className={SEGMENTED_GROUP_CLASS}>
          {buttons.map((option) => {
            const unavailable = option === 'html' && lines.html === null;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={shown === option}
                disabled={unavailable}
                onClick={() => setSource(option)}
                className={`${segmentClass(shown === option)} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {t(`sources.${option}`)}
              </button>
            );
          })}
        </div>
        {lines.html === null && <p className="text-xs text-gray-500 dark:text-gray-400">{t('noHtml')}</p>}
        {list.length >= MAX_PARSE_LINES && (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('capped', { max: MAX_PARSE_LINES })}</p>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
      ) : (
        <ol
          tabIndex={0}
          aria-label={t('listLabel')}
          className="max-h-80 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          {list.map((line, index) => (
            <li key={index} className="flex gap-3">
              <span aria-hidden="true" className="w-10 shrink-0 select-none text-right text-gray-400 dark:text-gray-500">
                {index + 1}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
