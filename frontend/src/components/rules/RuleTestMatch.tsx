'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Banner } from '@/components/rules/RuleEditorBanners';
import { TransactionList } from '@/components/transactions/TransactionList';
import { useRuleRunErrorMessage } from '@/components/rules/use-rule-run-error';
import { buildCategoryColorMap, buildCategoryIconMap, buildCategoryLabelMap } from '@/lib/categoryUtils';
import { createLogger } from '@/lib/logger';
import { conditionToApi } from '@/lib/rule-draft';
import { conditionGaps } from '@/lib/rule-errors';
import type { EditorGroup } from '@/lib/rule-tree';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { Category } from '@/types/category';
import type { Transaction } from '@/types/transaction';
import type { MatchDraftRuleData, RuleMatchPage } from '@/types/transaction-rule-run';

const logger = createLogger('RuleTestMatch');

/** Matches per page: the register's pager, a shorter page. */
export const RULE_MATCH_PAGE_SIZE = 10;

/** What a press of Test rule asked: the condition and window, fixed until the next press. */
interface Tested {
  request: Omit<MatchDraftRuleData, 'page' | 'limit'>;
  key: string;
}

/**
 * Each answer carries the key of the request that produced it (the tested
 * condition, the page and the reload), so a page is never shown for a request
 * it was not fetched for.
 */
type PageState =
  | { status: 'error'; key: string; error: unknown }
  | { status: 'done'; key: string; page: RuleMatchPage };

interface RuleTestMatchProps {
  condition: EditorGroup;
  /** The draft's active window, `YYYY-MM-DD`; blank is open on that side. */
  activeFrom: string;
  activeTo: string;
  /** The condition text does not parse, so the draft is not what the reader sees. */
  blocked?: boolean;
  categories: readonly Category[];
}

/**
 * "Test rule" in If: which existing transactions the conditions match, inside
 * the active window, drawn by the register's own list ten to a page. The
 * actions play no part, so it works before Then has one. Nothing is written.
 *
 * A press fixes the condition it was asked about; turning the page reads more
 * of that same answer. Editing the conditions afterwards leaves the list on
 * screen but marks it as out of date.
 */
export function RuleTestMatch({ condition, activeFrom, activeTo, blocked = false, categories }: RuleTestMatchProps) {
  const t = useTranslations('rules.match');
  const errorMessage = useRuleRunErrorMessage();
  const [tested, setTested] = useState<Tested | null>(null);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<PageState | null>(null);

  const current = useMemo(() => {
    // An open side is left out; the server reads absent as open.
    const request = {
      condition: conditionToApi(condition),
      ...(activeFrom ? { activeFrom } : {}),
      ...(activeTo ? { activeTo } : {}),
    };
    return { request, key: JSON.stringify(request) };
  }, [condition, activeFrom, activeTo]);

  const incomplete = blocked || conditionGaps(condition).length > 0;
  // A window that ends before it starts is refused by the server; do not send it.
  const windowBackwards = activeFrom !== '' && activeTo !== '' && activeFrom > activeTo;

  const requestKey = tested ? `${tested.key}|${page}|${reload}` : null;
  const loading = requestKey !== null && state?.key !== requestKey;
  const stale = tested !== null && tested.key !== current.key;

  useEffect(() => {
    if (!tested || requestKey === null) return;
    let cancelled = false;
    transactionRulesApi
      .matchDraft({ ...tested.request, page, limit: RULE_MATCH_PAGE_SIZE })
      .then((result) => {
        if (!cancelled) setState({ status: 'done', key: requestKey, page: result });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error', key: requestKey, error });
      });
    return () => {
      cancelled = true;
    };
  }, [tested, page, requestKey]);

  const test = () => {
    setTested(current);
    setPage(1);
    setReload((n) => n + 1);
    setOpen(true);
  };

  // A row deleted or its status cycled in the list: read the page again, since it may no longer match.
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const patchRow = useCallback(
    (updated: Transaction) =>
      setState((previous) =>
        previous?.status === 'done'
          ? {
              ...previous,
              page: {
                ...previous.page,
                data: previous.page.data.map((row) => (row.id === updated.id ? updated : row)),
              },
            }
          : previous,
      ),
    [],
  );

  const categoryLabelMap = useMemo(() => buildCategoryLabelMap([...categories]), [categories]);
  const categoryColorMap = useMemo(() => buildCategoryColorMap([...categories]), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap([...categories]), [categories]);

  // The last answer stays on screen while the next page loads, so the list does not jump.
  const shown = state?.status === 'done' ? state.page : null;
  const summary = shown ? t('summary', { count: shown.pagination.total }) : t('summaryPending');

  return (
    <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t('buttonLabel')}
          disabled={incomplete || windowBackwards}
          onClick={test}
        >
          {t('button')}
        </Button>
        {incomplete && <p className="text-sm text-gray-500 dark:text-gray-400">{t('incomplete')}</p>}
        {!incomplete && windowBackwards && (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('windowBackwards')}</p>
        )}
      </div>

      {tested && (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-3">
          <summary
            className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100"
            data-testid="rule-match-summary"
            onClick={(event) => {
              // Cancels the element's own toggle so `open` moves only through this state;
              // Enter and Space on a focused summary dispatch a click too.
              event.preventDefault();
              setOpen(!open);
            }}
          >
            {summary}
          </summary>
          <div className="mt-3" aria-live="polite" aria-busy={loading || stale}>
            {stale && (
              <p role="status" className="mb-3 text-sm text-amber-700 dark:text-amber-400">
                {t('stale')}
              </p>
            )}
            {loading && !shown && <LoadingSpinner text={t('running')} />}
            {!loading && state?.status === 'error' && (
              <Banner tone="red">
                <p>{t('failed', { message: errorMessage(state.error, 'testFailed') })}</p>
              </Banner>
            )}
            {shown && shown.truncated && (
              <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
                {t('truncated', { scanned: shown.scanned })}
              </p>
            )}
            {shown && state?.status === 'done' && shown.pagination.total === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
            )}
            {shown && state?.status === 'done' && shown.pagination.total > 0 && (
              <div
                className={stale || loading ? 'opacity-60' : undefined}
                data-testid="rule-match-result"
                data-stale={stale}
              >
                <TransactionList
                  densityView="ruleMatch"
                  transactions={shown.data}
                  onRefresh={refresh}
                  onTransactionUpdate={patchRow}
                  currentPage={shown.pagination.page}
                  totalPages={shown.pagination.totalPages}
                  totalItems={shown.pagination.total}
                  pageSize={RULE_MATCH_PAGE_SIZE}
                  onPageChange={setPage}
                  categoryLabelMap={categoryLabelMap}
                  categoryColorMap={categoryColorMap}
                  categoryIconMap={categoryIconMap}
                />
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
