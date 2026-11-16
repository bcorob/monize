'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmailHtmlFrame } from '@/components/email-receipts/EmailHtmlFrame';
import { EmailLinesView } from '@/components/email-receipts/EmailLinesView';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { looksLikeHtml } from '@/lib/email-receipts-format';
import type { EmailReceiptLines } from '@/types/email-receipts';

type BodyView = 'html' | 'text' | 'lines';

interface EmailBodyViewProps {
  bodyText: string;
  /** The HTML part the server kept, or `null`. */
  bodyHtml: string | null;
  /** The numbered lines each source gives; when present the "Lines" view is offered. */
  lines?: EmailReceiptLines;
}

/**
 * The body of a stored email: its HTML in a sandboxed frame by default, with a
 * toggle to the plain text and a third view of the numbered lines a parser's
 * patterns are matched against, per source (`EmailLinesView`).
 *
 * The HTML is `bodyHtml` when the server kept one; an email stored before that
 * was kept, whose text is itself markup (a sender that put HTML in a text part),
 * is treated the same way, so it shows as an email and not as angle brackets. The
 * text view always shows the stored text as text in a `<pre>`: markup there is
 * characters, never elements. With no HTML and no lines there is no toggle and
 * no note.
 */
export function EmailBodyView({ bodyText, bodyHtml, lines }: EmailBodyViewProps) {
  const t = useTranslations('emailReceipts.detail');
  const html = bodyHtml ?? (looksLikeHtml(bodyText) ? bodyText : null);
  const [view, setView] = useState<BodyView>('html');

  if (bodyText === '' && html === null && lines === undefined) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('noText')}</p>;
  }
  const shown: BodyView = view === 'lines' && lines !== undefined ? 'lines' : html !== null && view === 'html' ? 'html' : 'text';
  const hasToggle = html !== null || lines !== undefined;

  return (
    <div className="space-y-2">
      {hasToggle && (
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label={t('bodyView.label')} className={SEGMENTED_GROUP_CLASS}>
            {html !== null && (
              <button type="button" aria-pressed={shown === 'html'} onClick={() => setView('html')} className={segmentClass(shown === 'html')}>
                {t('bodyView.html')}
              </button>
            )}
            <button type="button" aria-pressed={shown === 'text'} onClick={() => setView('text')} className={segmentClass(shown === 'text')}>
              {t('bodyView.text')}
            </button>
            {lines !== undefined && (
              <button type="button" aria-pressed={shown === 'lines'} onClick={() => setView('lines')} className={segmentClass(shown === 'lines')}>
                {t('bodyView.lines')}
              </button>
            )}
          </div>
          {shown === 'html' && <p className="text-xs text-gray-500 dark:text-gray-400">{t('remoteImagesNote')}</p>}
        </div>
      )}
      {shown === 'lines' && lines !== undefined ? (
        <EmailLinesView lines={lines} />
      ) : shown === 'html' && html !== null ? (
        <EmailHtmlFrame html={html} title={t('htmlFrameTitle')} />
      ) : bodyText === '' ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('noText')}</p>
      ) : (
        <pre
          tabIndex={0}
          aria-label={t('textLabel')}
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          {bodyText}
        </pre>
      )}
    </div>
  );
}
