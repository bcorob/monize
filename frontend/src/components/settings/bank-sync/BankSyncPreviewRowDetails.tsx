'use client';

import { useTranslations } from 'next-intl';
import { ImportPreviewPayeeMapping, IMPORT_PREVIEW_HEADING_CLASS } from '@/components/import-preview/ImportPreviewPayeeMapping';
import { ImportPreviewRuleTest } from '@/components/import-preview/ImportPreviewRuleTest';
import type { BankSyncPreviewRow } from '@/types/bank-sync';

/** The id the expand button points at, so the details are named by the row they belong to. */
export function previewDetailsId(prefix: string, key: string): string {
  return `${prefix}-details-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

interface PreviewRowDetailsProps {
  id: string;
  row: BankSyncPreviewRow;
}

/**
 * What lies behind a row (spec section 7b): the import rules tested against it
 * (each rule, whether it matched, its condition and what it would change; loaded
 * as soon as the row is expanded), how the bank's counterparty text became the
 * payee (with a way to the payee's aliases), and the operation-type tag. The
 * rules and the payee come from the source-neutral import preview pieces; the
 * operation type is the bank's own.
 */
export function PreviewRowDetails({ id, row }: PreviewRowDetailsProps) {
  const t = useTranslations('settings.bankSync.preview.details.operation');

  return (
    <div
      id={id}
      className="space-y-3 rounded-md bg-gray-50 p-3 text-sm text-gray-900 dark:bg-gray-900/40 dark:text-gray-100"
    >
      <ImportPreviewRuleTest rowKey={row.externalKey ?? id} ruleInput={row.ruleInput} />
      <ImportPreviewPayeeMapping payee={row.payee} />
      <section aria-label={t('heading')} className="space-y-1">
        <h4 className={IMPORT_PREVIEW_HEADING_CLASS}>{t('heading')}</h4>
        <p className={row.operationTag === null ? 'text-gray-600 dark:text-gray-300' : undefined}>
          {row.operationTag === null ? t('none') : t('tag', { tag: row.operationTag })}
        </p>
      </section>
    </div>
  );
}
