'use client';

import { useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { formatDefinitionJson } from '@/lib/receipt-parser-form';
import type { EmailReceiptParser } from '@/types/email-receipts';

interface ParserJsonDialogProps {
  parser: EmailReceiptParser;
  onClose: () => void;
}

/**
 * A parser's stored definition as pretty-printed JSON, read-only, with a Copy
 * button. For every parser, draft or approved, valid or not: it shows what is
 * stored, so a definition the form cannot show is still readable here. The text
 * goes in a `<pre>` as a text node, never as HTML.
 */
export function ParserJsonDialog({ parser, onClose }: ParserJsonDialogProps) {
  const t = useTranslations('emailReceipts.parsers.jsonDialog');
  const tc = useTranslations('common');
  const json = useMemo(() => formatDefinitionJson(parser.definition), [parser.definition]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success(t('copied'));
    } catch {
      // No clipboard (an insecure page) or a refused permission.
      toast.error(t('copyFailed'));
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="2xl"
      padding="md"
      pushHistory
      title={t('title', { name: parser.name })}
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('close')}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('help')}</p>
        <pre
          tabIndex={0}
          aria-label={t('contentLabel')}
          className="max-h-96 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          {json}
        </pre>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => void handleCopy()}>
            {t('copy')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
