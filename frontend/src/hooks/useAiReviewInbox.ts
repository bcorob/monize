'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { aiApi } from '@/lib/ai';
import { aiReviewApi } from '@/lib/ai-review-api';
import { notifyAiAction } from '@/lib/aiActionSignal';
import { clearAllCache } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { PendingAction } from '@/types/ai';
import {
  AI_REVIEW_APPROVE_BATCH_MAX,
  isApprovable,
  isSendableToAssistant,
  type AiReviewApproveBatchItemResult,
  type AiReviewFilter,
  type AiReviewItem,
  type AiReviewKindFilter,
} from '@/types/ai-review';

const logger = createLogger('AiReviewInbox');

/** What the approval of one proposal is doing, kept beside the list, not in it. */
export interface ProposalCardState {
  status: 'confirming' | 'confirmed' | 'error';
  errorMessage?: string;
  resultId?: string;
}

/** What a bulk approval did, kept until the person closes the summary. */
export interface BatchSummary {
  approved: number;
  failed: number;
  /** The requests that were not approved, with the reason each gave. */
  failures: AiReviewApproveBatchItemResult[];
}

const isConflict = (error: unknown) => error instanceof AxiosError && error.response?.status === 409;

/** The requests a kind filter shows. A parser draft has no card, so it is under "all" only. */
export function itemsOfKind(items: readonly AiReviewItem[], kind: AiReviewKindFilter): AiReviewItem[] {
  if (kind === 'all') return [...items];
  // A trade confirmation is an order email's proposal too.
  if (kind === 'email_receipt') return items.filter((item) => item.kind === 'email_receipt' || item.kind === 'email_trade');
  return items.filter((item) => item.kind === kind);
}

/**
 * The inbox's data and its two writes. `items === null` means not loaded (or
 * loading a new filter); it never stands in for an empty list, and a failed
 * load is `loadFailed`, never `[]`.
 */
export function useAiReviewInbox(initialKind: AiReviewKindFilter = 'all') {
  const t = useTranslations('aiReview');
  const [filter, setFilterState] = useState<AiReviewFilter>('open');
  const [kind, setKindState] = useState<AiReviewKindFilter>(initialKind);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [batching, setBatching] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [items, setItems] = useState<AiReviewItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cards, setCards] = useState<Record<string, ProposalCardState>>({});
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());
  // Only the newest request may write the list.
  const latestLoad = useRef(0);

  const load = useCallback(() => {
    // Every state write here follows the `await`. Keeping them in this inner
    // function rather than in `load` itself is what lets the effect below call
    // `load` without being read as a synchronous setState.
    const fetchList = async () => {
      const request = ++latestLoad.current;
      try {
        const data = await aiReviewApi.list(filter);
        if (request !== latestLoad.current) return;
        setItems(data);
        setLoadFailed(false);
      } catch (error) {
        if (request !== latestLoad.current) return;
        // A list that could not be refreshed is not shown as if it were current.
        setItems(null);
        setLoadFailed(true);
        logger.error(error);
      }
    };
    return fetchList();
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new filter is a new list: the previous one must not stay actionable.
  const setFilter = (next: AiReviewFilter) => {
    if (next === filter) return;
    setItems(null);
    setLoadFailed(false);
    setCards({});
    setSelectedIds(new Set());
    setFilterState(next);
  };

  // The kind filter narrows the list already loaded; a selection never outlives it.
  const setKind = (next: AiReviewKindFilter) => {
    if (next === kind) return;
    setSelectedIds(new Set());
    setKindState(next);
  };

  // What is shown, and which of it can be approved. A selection counts only what is still on screen
  // and still approvable: a row a reload dropped, or one that was applied, is not selected.
  const shownItems = items === null ? null : itemsOfKind(items, kind);
  const approvable = (shownItems ?? []).filter(isApprovable);
  const selected = approvable.filter((item) => selectedIds.has(item.id));
  // Pending rows share the selection: their checkboxes pick what goes to the assistant.
  const sendable = (shownItems ?? []).filter(isSendableToAssistant);
  const selectedSendable = sendable.filter((item) => selectedIds.has(item.id));

  const toggleSelected = (id: string) =>
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearSelection = () => setSelectedIds(new Set());

  const retry = () => {
    setItems(null);
    setLoadFailed(false);
    void load();
  };

  const patchCard = (id: string, card: ProposalCardState | null) =>
    setCards((prev) => {
      const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
      return card ? { ...rest, [id]: card } : rest;
    });

  /** A 409: the request changed under the person. `message` is the server's own reason, when it gave one. */
  const reloadAfterConflict = async (message?: string) => {
    toast.error(message ?? t('toasts.changed'));
    setCards({});
    await load();
  };

  /** Commits the stored pending action through the chat's own confirm client. */
  const approve = async (item: AiReviewItem, action: Omit<PendingAction, 'status'>) => {
    patchCard(item.id, { status: 'confirming' });
    try {
      const res = await aiApi.confirmAction({
        actionId: action.actionId,
        signature: action.signature,
        descriptor: action.descriptor,
      });
      // The write landed: drop every cached read the edit may have changed
      // and tell mounted list pages, exactly as the chat's confirm does.
      clearAllCache();
      notifyAiAction();
      patchCard(item.id, { status: 'confirmed', resultId: res.id });
      setItems((prev) => prev && prev.map((i) => (i.id === item.id ? { ...i, status: 'applied' } : i)));
      toast.success(t('toasts.approved'));
    } catch (error) {
      if (isConflict(error)) {
        // The confirm says why it refused (the trade is already in the ledger, the
        // email was linked meanwhile, ...); a bare 409 is the generic "changed".
        await reloadAfterConflict(getErrorMessage(error, t('toasts.changed')));
        return;
      }
      logger.error(error);
      patchCard(item.id, { status: 'error', errorMessage: getErrorMessage(error, t('toasts.approveFailed')) });
    }
  };

  /**
   * Approve these requests through the server's bulk route, which rebuilds each
   * card against its transaction as it is now and commits it through the same
   * confirm a single approval uses, one transaction per request. At most 100 go in
   * one call, so a longer list is sent in chunks, in order. The list is read again
   * afterwards whatever happened: some of it changed.
   */
  const approveBatch = async (requests: readonly AiReviewItem[]) => {
    if (requests.length === 0 || batching) return;
    setBatching(true);
    setSummary(null);
    const results: AiReviewApproveBatchItemResult[] = [];
    try {
      for (let at = 0; at < requests.length; at += AI_REVIEW_APPROVE_BATCH_MAX) {
        const chunk = requests.slice(at, at + AI_REVIEW_APPROVE_BATCH_MAX).map((request) => request.id);
        const answer = await aiReviewApi.approveBatch(chunk);
        results.push(...answer.results);
      }
    } catch (error) {
      logger.error(error);
      toast.error(getErrorMessage(error, t('bulk.failed')));
    } finally {
      const approved = results.filter((result) => result.ok).length;
      if (approved > 0) {
        // The writes landed: drop every cached read they may have changed, as a single approval does.
        clearAllCache();
        notifyAiAction();
      }
      if (results.length > 0) {
        setSummary({ approved, failed: results.length - approved, failures: results.filter((result) => !result.ok) });
      }
      setSelectedIds(new Set());
      setCards({});
      await load();
      setBatching(false);
    }
  };

  const dismiss = async (item: AiReviewItem) => {
    setDismissing((prev) => new Set(prev).add(item.id));
    try {
      await aiReviewApi.dismiss(item.id);
      toast.success(t('toasts.dismissed'));
      await load();
    } catch (error) {
      if (isConflict(error)) {
        await reloadAfterConflict();
      } else {
        toast.error(getErrorMessage(error, t('toasts.dismissFailed')));
        logger.error(error);
      }
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  return {
    filter,
    setFilter,
    kind,
    setKind,
    items,
    shownItems,
    approvable,
    selected,
    sendable,
    selectedSendable,
    toggleSelected,
    clearSelection,
    batching,
    summary,
    clearSummary: () => setSummary(null),
    approveBatch,
    loadFailed,
    retry,
    cards,
    dismissing,
    approve,
    dismiss,
  };
}
