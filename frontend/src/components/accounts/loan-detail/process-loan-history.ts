import { getErrorCode } from '@/lib/errors';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { RuleRunFilters, RuleRunSkippedRow } from '@/types/transaction-rule-run';

/** Rows one page of "Process history" examines: the server's run cap (`MAX_RULE_RUN_LIMIT`). */
export const PROCESS_HISTORY_PAGE_LIMIT = 1000;

/** How often one page is previewed again after its commit was refused `PREVIEW_CHANGED`. */
const MAX_PREVIEW_CHANGED_RETRIES = 3;

/** What the pages committed so far did. */
export interface ProcessHistoryProgress {
  /** Rows the committed pages changed (settled), each counted once. */
  settled: number;
  pages: number;
  /** Rows the rule reached and left alone, each once with its latest reason. */
  skipped: RuleRunSkippedRow[];
}

export type ProcessHistoryResult =
  | ({ status: 'done' } & ProcessHistoryProgress)
  /** A page could not advance: more rows on `date` than one page holds (null: the server did not say where the scan reached). */
  | ({ status: 'stuck'; date: string | null } & ProcessHistoryProgress)
  /** A request failed; the pages before it stay committed. */
  | ({ status: 'failed'; error: unknown } & ProcessHistoryProgress);

/**
 * "Process history" (`docs/specs/loan-installment-settlement.md` section
 * 14.1): the ordinary manual run of the loan's payment-matching rule over the
 * source account, page by page. A rule that settles scans oldest first, so
 * each page previews, commits exactly that preview, and the next page starts
 * on the date the previous one reached (`scannedThrough`, inclusive). Rows of
 * that date the previous page settled are splits now and are refused
 * `row_has_splits`, so a re-scan writes nothing twice; those refusals are
 * not reported. Stops when a page is not truncated, and reports the date when
 * a page cannot advance. Never throws: a failure is a result carrying what
 * the pages before it committed.
 */
export async function processLoanHistory(
  ruleId: string,
  sourceAccountId: string,
  onProgress?: (progress: ProcessHistoryProgress) => void,
): Promise<ProcessHistoryResult> {
  const settled = new Set<string>();
  const skipped = new Map<string, RuleRunSkippedRow>();
  let pages = 0;
  let startDate: string | undefined;
  let retries = 0;

  const progress = (): ProcessHistoryProgress => ({
    settled: settled.size,
    pages,
    skipped: [...skipped.values()],
  });
  const keepSkipped = (rows: readonly RuleRunSkippedRow[]) => {
    for (const row of rows) {
      if (!settled.has(row.transactionId)) skipped.set(row.transactionId, row);
    }
  };

  try {
    for (;;) {
      const filters: RuleRunFilters = {
        accountIds: [sourceAccountId],
        limit: PROCESS_HISTORY_PAGE_LIMIT,
        ...(startDate !== undefined ? { startDate } : {}),
      };
      const preview = await transactionRulesApi.previewRun(ruleId, filters);
      if (preview.matched.length > 0) {
        let result;
        try {
          result = await transactionRulesApi.run(ruleId, filters, preview.fingerprint);
        } catch (error) {
          // Nothing was written: the page moved under the preview. Preview it again.
          if (getErrorCode(error) === 'PREVIEW_CHANGED' && retries < MAX_PREVIEW_CHANGED_RETRIES) {
            retries += 1;
            continue;
          }
          throw error;
        }
        for (const row of preview.matched) {
          settled.add(row.transactionId);
          skipped.delete(row.transactionId);
        }
        keepSkipped(result.skipped);
      } else {
        keepSkipped(preview.skipped);
      }
      retries = 0;
      pages += 1;
      onProgress?.(progress());

      if (!preview.truncated) return { status: 'done', ...progress() };
      const next = preview.scannedThrough ?? null;
      if (next === null || next === startDate) {
        return { status: 'stuck', date: next, ...progress() };
      }
      startDate = next;
    }
  } catch (error) {
    return { status: 'failed', error, ...progress() };
  }
}
