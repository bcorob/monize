'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { LOAN_SETTLEMENT_MISSING_INPUTS } from '@/lib/rule-fields';
import {
  RULE_SKIP_REASONS,
  type RuleRunPreview,
  type RuleRunResult,
  type RuleRunSkipReason,
  type RuleRunSkippedRow,
} from '@/types/transaction-rule-run';

const isSkipReason = (reason: string): reason is RuleRunSkipReason =>
  (RULE_SKIP_REASONS as readonly string[]).includes(reason);

const isMissingInput = (value: string): value is (typeof LOAN_SETTLEMENT_MISSING_INPUTS)[number] =>
  (LOAN_SETTLEMENT_MISSING_INPUTS as readonly string[]).includes(value);

/** The reason a row was left alone, as a sentence. */
export function useSkipReasonText(): (reason: string) => string {
  const t = useTranslations('rules.run.skipReasons');
  // A reason newer than this client still says that the row was left alone.
  return (reason) => (isSkipReason(reason) ? t(reason) : t('other'));
}

/** Skipped rows carry only an id; the reason is what the reader can act on. */
export function RuleRunSkippedList({ skipped }: { skipped: readonly RuleRunSkippedRow[] }) {
  const t = useTranslations('rules.run');
  const format = useFormatter();
  const reasonText = useSkipReasonText();
  if (skipped.length === 0) return null;

  // One line per reason with a count: the ids alone would tell the reader nothing.
  const counts = new Map<string, number>();
  // What a settlement refusal names as missing, so the reader knows what to set on the loan.
  const missing = new Map<string, Set<string>>();
  for (const row of skipped) {
    counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
    for (const input of row.detail?.missing ?? []) {
      const inputs = missing.get(row.reason) ?? new Set<string>();
      inputs.add(input);
      missing.set(row.reason, inputs);
    }
  }
  const missingText = (reason: string): string | null => {
    const inputs = missing.get(reason);
    if (inputs === undefined || inputs.size === 0) return null;
    const names = [...inputs].map((input) => (isMissingInput(input) ? t(`missingInputs.${input}`) : t('missingInputs.other')));
    return t('skipped.missing', { inputs: format.list([...new Set(names)], { type: 'conjunction' }) });
  };

  return (
    <div className="mt-4" data-testid="rule-run-skipped">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('skipped.title', { count: skipped.length })}
      </h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-600 dark:text-gray-300">
        {[...counts].map(([reason, count]) => (
          <li key={reason}>
            {t('skipped.line', { count, reason: reasonText(reason) })}
            {missingText(reason) !== null && <span className="block">{missingText(reason)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a confirmed run did about AI reviews; nothing when it asked for none. */
export function RuleRunAiReviewOutcome({
  result,
}: {
  result: Pick<RuleRunResult, 'aiReviewsQueued' | 'aiReviewsAlreadyQueued'>;
}) {
  const t = useTranslations('rules.run');
  return (
    <>
      {result.aiReviewsQueued > 0 && (
        <p className="text-sm text-gray-900 dark:text-gray-100">
          {t('done.aiReviewsQueued', { count: result.aiReviewsQueued })}
        </p>
      )}
      {result.aiReviewsAlreadyQueued > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t('done.aiReviewsAlreadyQueued', { count: result.aiReviewsAlreadyQueued })}
        </p>
      )}
    </>
  );
}

interface RuleRunPreviewTableProps {
  preview: RuleRunPreview;
}

/**
 * What a test or a run would change: a count line, the rows with their planned
 * change in words, and the rows the rule reached but leaves alone. "Nothing
 * matched" is its own message, never an empty table.
 */
export function RuleRunPreviewTable({ preview }: RuleRunPreviewTableProps) {
  const t = useTranslations('rules.run');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const changeText = useRuleChangeText();
  const { labels } = preview;
  const names = {
    category: (id: string) => labels.categories[id],
    payee: (id: string) => labels.payees[id],
    tag: (id: string) => labels.tags[id],
    account: (id: string) => labels.accounts[id],
  };

  return (
    <div>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('summary', { matched: preview.matched.length, scanned: preview.scanned })}
      </p>
      {preview.truncated && (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
          {preview.scanOrder === 'oldest_first' ? t('truncatedOldest') : t('truncated')}
        </p>
      )}

      {preview.aiReviewRequests > 0 && (
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300" data-testid="rule-run-ai-review">
          {t('aiReview', { count: preview.aiReviewRequests })}
        </p>
      )}

      {preview.matched.length === 0 ? (
        // A run that only queues reviews has nothing to list, but it is not "nothing would change".
        preview.aiReviewRequests === 0 && (
          <EmptyState
            className="py-6"
            title={t('noMatches.title')}
            description={
              preview.conditionMatchedCount > 0
                ? t('noChange', {
                    matched: preview.conditionMatchedCount,
                    scanned: preview.scanned,
                  })
                : t('noMatches.body')
            }
          />
        )
      ) : (
        <div className="mt-3 max-h-96 overflow-auto">
          <table className={TABLE_CLASS}>
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <Th>{t('table.date')}</Th>
                <Th>{t('table.payee')}</Th>
                <Th align="right">{t('table.amount')}</Th>
                <Th>{t('table.change')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {preview.matched.map((row) => (
                <tr key={row.transactionId}>
                  <Td className="whitespace-nowrap">{formatDate(row.date)}</Td>
                  <Td>{row.payeeName ?? <span className="text-gray-500 dark:text-gray-400">{t('table.noPayee')}</span>}</Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatCurrency(row.amount, row.currencyCode)}
                  </Td>
                  <Td>
                    <ul className="space-y-0.5">
                      {changeText(row.changes, names, { currencyCode: row.currencyCode }).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RuleRunSkippedList skipped={preview.skipped} />
    </div>
  );
}
