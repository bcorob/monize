import apiClient from './api';
import { clearAllCache } from './apiCache';
import { receiptSearchParams } from './receipt-search';
import { AI_REVIEW_APPROVE_BATCH_MAX } from '@/types/email-receipts';
import type {
  EmailReceiptApproveResult,
  EmailReceiptBulkApprovable,
  EmailReceiptBulkFilter,
  EmailReceiptBulkPayload,
  EmailReceiptBulkReprocessPayload,
  EmailReceiptBulkReprocessResult,
  EmailReceiptBulkScope,
  EmailReceiptBulkResult,
  EmailReceiptDomainCount,
  CreateEmailReceiptParserPayload,
  EmailReceiptAskAiResult,
  EmailReceiptDetail,
  EmailReceiptImportResult,
  EmailReceiptListItem,
  EmailReceiptSearch,
  EmailReceiptMailbox,
  EmailReceiptMailboxTestResult,
  EmailReceiptParserDraftRequestResult,
  EmailReceiptOAuthProvider,
  EmailReceiptOAuthProviders,
  EmailReceiptParser,
  EmailReceiptParserTestResult,
  EmailReceiptPollResult,
  EmailReceiptsOverview,
  GenerateParserWithAiPayload,
  GenerateParserWithAiResult,
  ParserPreviewResult,
  PreviewEmailReceiptParserPayload,
  UncoveredDomain,
  EmailReceiptStatusCounts,
  EmailReceiptStatus,
  ProcessEmailReceiptsPayload,
  ProcessEmailReceiptsResult,
  ProfileBatchPayload,
  ProfileBatchResult,
  TestEmailReceiptMailboxPayload,
  TestEmailReceiptParserPayload,
  UpdateEmailReceiptMailboxSettingsPayload,
  UpdateEmailReceiptParserPayload,
  UpsertEmailReceiptMailboxPayload,
} from '@/types/email-receipts';

/**
 * Email receipts: the mailbox, its OAuth login, the stored emails and the
 * parsers that read them. Deliberately uncached, like `aiReviewApi`: the poll
 * runs on the server's schedule and a receipt's state changes under the page
 * (a poll stores mail, an approval closes a request), so a cached list would
 * offer an action for a state the email has already left.
 *
 * Nothing here moves money. A proposal is committed from the review inbox by
 * `aiApi.confirmAction`, which owns the cache invalidation for it.
 */

const MAILBOX = '/email-receipts/mailbox';
const RECEIPTS = '/email-receipts';
const PARSERS = '/email-receipt-parsers';

/** A mailbox answer is a view object; anything else (an empty body) is "no mailbox". */
function readMailbox(data: unknown): EmailReceiptMailbox | null {
  return typeof data === 'object' && data !== null && 'id' in data ? (data as EmailReceiptMailbox) : null;
}

export const emailReceiptsApi = {
  mailbox: {
    /** `null` when the user has no mailbox: the server answers an empty body, never a 404. */
    get: async (): Promise<EmailReceiptMailbox | null> => {
      const response = await apiClient.get<unknown>(MAILBOX);
      return readMailbox(response.data);
    },

    /** Create or replace. The password goes only when the user typed one; it is never returned. */
    upsert: async (payload: UpsertEmailReceiptMailboxPayload): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.put<EmailReceiptMailbox>(MAILBOX, payload);
      return response.data;
    },

    /** The settings an OAuth mailbox has (folder, enabled, AI mode, auto-apply). */
    updateSettings: async (payload: UpdateEmailReceiptMailboxSettingsPayload): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.patch<EmailReceiptMailbox>(`${MAILBOX}/settings`, payload);
      return response.data;
    },

    remove: async (): Promise<void> => {
      await apiClient.delete(MAILBOX);
    },

    /** Test a draft (or, with an empty body, the stored settings) without saving. */
    test: async (payload: TestEmailReceiptMailboxPayload = {}): Promise<EmailReceiptMailboxTestResult> => {
      const response = await apiClient.post<EmailReceiptMailboxTestResult>(`${MAILBOX}/test`, payload);
      return response.data;
    },

    pollNow: async (): Promise<EmailReceiptPollResult> => {
      const response = await apiClient.post<EmailReceiptPollResult>(`${MAILBOX}/poll`);
      return response.data;
    },

    /**
     * Upload exported `.eml`, `.mbox`, `.msg` or `.zip` files into the mailbox (at most 20 files,
     * 25 MB each). Each file is answered on its own: a refused one carries an
     * `error` and the rest are still read. The multipart header replaces the
     * client's JSON default, as in the other uploads; axios adds the boundary.
     * `process: false` only stores the emails (the answer has `processed` 0); the
     * caller processes them afterwards with `receipts.processBatch`.
     */
    import: async (
      files: readonly File[],
      options: { process?: boolean } = {},
    ): Promise<EmailReceiptImportResult> => {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const response = await apiClient.post<EmailReceiptImportResult>(`${MAILBOX}/import`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        ...(options.process === undefined ? {} : { params: { process: String(options.process) } }),
        timeout: 180_000,
      });
      return response.data;
    },
  },

  oauth: {
    providers: async (): Promise<EmailReceiptOAuthProviders> => {
      const response = await apiClient.get<EmailReceiptOAuthProviders>(`${MAILBOX}/oauth/providers`);
      return response.data;
    },

    /** The provider's consent URL; the caller navigates the browser to it. */
    start: async (provider: EmailReceiptOAuthProvider): Promise<{ authorizationUrl: string }> => {
      const response = await apiClient.post<{ authorizationUrl: string }>(`${MAILBOX}/oauth/start`, { provider });
      return response.data;
    },

    /** Exchange the `code` and `state` the provider returned. Single use: a retry is refused. */
    complete: async (code: string, state: string): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.post<EmailReceiptMailbox>(`${MAILBOX}/oauth/complete`, { code, state });
      return response.data;
    },

    /** Forget the stored token. The grant itself is revoked at the provider. */
    disconnect: async (): Promise<void> => {
      await apiClient.delete(`${MAILBOX}/oauth`);
    },
  },

  receipts: {
    /**
     * `domain` keeps the emails from that sender domain or one of its sub-domains; it combines with `status`
     * and with `search` (text and dates; only the fields that are set are sent).
     */
    list: async (
      status?: EmailReceiptStatus,
      limit?: number,
      domain?: string,
      offset?: number,
      search?: EmailReceiptSearch,
    ): Promise<EmailReceiptListItem[]> => {
      const params = {
        ...(status ? { status } : {}),
        ...(domain ? { domain } : {}),
        ...receiptSearchParams(search),
        ...(limit ? { limit } : {}),
        ...(offset ? { offset } : {}),
      };
      const response = await apiClient.get<EmailReceiptListItem[]>(RECEIPTS, {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    },

    /**
     * The sender domains of the stored emails with their counts, most first (at
     * most 200). With `status` the counts are those of the emails in that state;
     * with `search` only the emails that match it are counted.
     */
    listDomains: async (status?: EmailReceiptStatus, search?: EmailReceiptSearch): Promise<EmailReceiptDomainCount[]> => {
      const params = { ...(status ? { status } : {}), ...receiptSearchParams(search) };
      const response = await apiClient.get<EmailReceiptDomainCount[]>(`${RECEIPTS}/domains`, {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    },

    /**
     * Sender domains of stored emails that no approved profile covers, most
     * emails first (at most 200); `draftParserId` names a draft already written.
     */
    listUncovered: async (): Promise<UncoveredDomain[]> => {
      const response = await apiClient.get<UncoveredDomain[]>(`${RECEIPTS}/domains/uncovered`);
      return response.data;
    },

    /** How many stored emails are in each state (those matching `search`, when given); the filter bar prints them. */
    getStatusCounts: async (search?: EmailReceiptSearch): Promise<EmailReceiptStatusCounts> => {
      const params = receiptSearchParams(search);
      const url = `${RECEIPTS}/status-counts`;
      const response =
        Object.keys(params).length > 0
          ? await apiClient.get<{ total: number; byStatus: EmailReceiptStatusCounts }>(url, { params })
          : await apiClient.get<{ total: number; byStatus: EmailReceiptStatusCounts }>(url);
      return response.data.byStatus;
    },

    /**
     * How many stored emails match a filter (state and sender domain, as the
     * list reads them): the same `status-counts` answer the state buttons print,
     * so a bulk command's number and the page's number come from one place.
     * Without `status` it is every state. `search` narrows it as it narrows the list.
     */
    countMatching: async (status?: EmailReceiptStatus, domain?: string, search?: EmailReceiptSearch): Promise<number> => {
      const params = { ...(domain ? { domain } : {}), ...receiptSearchParams(search) };
      const response = await apiClient.get<{
        total: number;
        byStatus: EmailReceiptStatusCounts;
      }>(`${RECEIPTS}/status-counts`, { params: Object.keys(params).length > 0 ? params : undefined });
      return status ? (response.data.byStatus[status] ?? 0) : response.data.total;
    },

    /**
     * Delete or ignore many emails, by id or by the list's filter, in one
     * transaction. `expectedCount` is what the person was told: a different
     * number answers 409 with `currentCount` and changes nothing. Emails linked
     * to a transaction are skipped and counted.
     */
    bulk: async (payload: EmailReceiptBulkPayload): Promise<EmailReceiptBulkResult> => {
      const response = await apiClient.post<EmailReceiptBulkResult>(`${RECEIPTS}/bulk`, payload);
      return response.data;
    },

    /** How many emails a narrowed filter selects, the number a bulk command acts on. */
    bulkCount: async (filter: EmailReceiptBulkFilter): Promise<number> => {
      const response = await apiClient.post<{ count: number }>(`${RECEIPTS}/bulk/count`, { filter });
      return response.data.count;
    },

    /**
     * Reprocess up to `limit` emails of a selection (oldest first, each once per
     * run). Call again with the answer's `since` until `remaining` is 0.
     */
    bulkReprocess: async (payload: EmailReceiptBulkReprocessPayload): Promise<EmailReceiptBulkReprocessResult> => {
      const response = await apiClient.post<EmailReceiptBulkReprocessResult>(`${RECEIPTS}/bulk/reprocess`, payload);
      return response.data;
    },

    /** The review requests of the selection's proposals that can be approved, and how many trade emails were left out. */
    bulkApprovable: async (scope: EmailReceiptBulkScope): Promise<EmailReceiptBulkApprovable> => {
      const response = await apiClient.post<EmailReceiptBulkApprovable>(`${RECEIPTS}/bulk/approvable`, scope);
      return response.data;
    },

    /**
     * Approve many proposals by the review inbox's batch route, 100 requests a
     * call. A call that fails counts all its requests as failed and the rest
     * still run. It edits transactions, so every cached balance is dropped.
     */
    approveRequests: async (ids: readonly string[]): Promise<EmailReceiptApproveResult> => {
      let approved = 0;
      let failed = 0;
      try {
        for (let start = 0; start < ids.length; start += AI_REVIEW_APPROVE_BATCH_MAX) {
          const chunk = ids.slice(start, start + AI_REVIEW_APPROVE_BATCH_MAX);
          try {
            const response = await apiClient.post<{ results: { id: string; ok: boolean; error?: string }[] }>(
              '/ai-review-requests/approve-batch',
              { ids: chunk },
            );
            const ok = response.data.results.filter((r) => r.ok).length;
            approved += ok;
            failed += chunk.length - ok;
          } catch {
            failed += chunk.length;
          }
        }
      } finally {
        clearAllCache();
      }
      return { approved, failed };
    },

    /**
     * Approve the proposal this email made (its open AI review request) by
     * the review inbox's own batch route. It edits a transaction, so every
     * cached balance is dropped; a request the server refused throws.
     */
    approveProposal: async (aiReviewRequestId: string): Promise<void> => {
      const response = await apiClient.post<{
        results: { id: string; ok: boolean; error?: string }[];
      }>('/ai-review-requests/approve-batch', { ids: [aiReviewRequestId] });
      clearAllCache();
      const failed = response.data.results.find((r) => !r.ok);
      if (failed) throw new Error(failed.error ?? 'approve failed');
    },

    /** What the hub's Overview cards show: one request, counts and names only. */
    overview: async (): Promise<EmailReceiptsOverview> => {
      const response = await apiClient.get<EmailReceiptsOverview>(`${RECEIPTS}/overview`);
      return response.data;
    },

    /**
     * Run the pipeline over up to `limit` stored emails (oldest first, one after
     * the other) and answer where they ended and how many are left. Send the
     * answer's `since` back to continue the same run; `remaining` 0 ends it.
     */
    processBatch: async (payload: ProcessEmailReceiptsPayload = {}): Promise<ProcessEmailReceiptsResult> => {
      const response = await apiClient.post<ProcessEmailReceiptsResult>(`${RECEIPTS}/process-batch`, payload);
      return response.data;
    },

    /**
     * Count, ignore or delete one page of the stored emails a profile matches.
     * Send the answer's `next` back as `after` until it is null
     * (`sweepProfileEmails` does).
     */
    profileBatch: async (payload: ProfileBatchPayload): Promise<ProfileBatchResult> => {
      const response = await apiClient.post<ProfileBatchResult>(`${RECEIPTS}/profile-batch`, payload);
      return response.data;
    },

    get: async (id: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.get<EmailReceiptDetail>(`${RECEIPTS}/${id}`);
      return response.data;
    },

    /** Null (an empty answer) when the email is gone: its profile deletes every email it matches. */
    reprocess: async (id: string): Promise<EmailReceiptDetail | null> => {
      const response = await apiClient.post<EmailReceiptDetail | '' | null>(`${RECEIPTS}/${id}/reprocess`);
      return response.data === '' || response.data === null ? null : response.data;
    },

    link: async (id: string, transactionId: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.post<EmailReceiptDetail>(`${RECEIPTS}/${id}/link`, { transactionId });
      return response.data;
    },

    ignore: async (id: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.post<EmailReceiptDetail>(`${RECEIPTS}/${id}/ignore`);
      return response.data;
    },

    remove: async (id: string): Promise<void> => {
      await apiClient.delete(`${RECEIPTS}/${id}`);
    },

    /**
     * Queue an AI review request for the email, for its own transaction or the
     * one named. No provider is called: the request waits, pending, for the
     * assistant in the chat (or an MCP agent) to claim it by id.
     */
    askAi: async (id: string, transactionId?: string, options: { asTrade?: boolean } = {}): Promise<EmailReceiptAskAiResult> => {
      const response = await apiClient.post<EmailReceiptAskAiResult>(`${RECEIPTS}/${id}/ask-ai`, {
        ...(transactionId === undefined ? {} : { transactionId }),
        ...(options.asTrade ? { asTrade: true } : {}),
      });
      return response.data;
    },
  },

  parsers: {
    list: async (): Promise<EmailReceiptParser[]> => {
      const response = await apiClient.get<EmailReceiptParser[]>(PARSERS);
      return response.data;
    },

    get: async (id: string): Promise<EmailReceiptParser> => {
      const response = await apiClient.get<EmailReceiptParser>(`${PARSERS}/${id}`);
      return response.data;
    },

    /** A parser a person wrote is approved on creation. */
    create: async (payload: CreateEmailReceiptParserPayload): Promise<EmailReceiptParser> => {
      const response = await apiClient.post<EmailReceiptParser>(PARSERS, payload);
      return response.data;
    },

    /** `expectedRevision` is a compare-and-swap: a parser that moved on answers 409. */
    update: async (id: string, payload: UpdateEmailReceiptParserPayload): Promise<EmailReceiptParser> => {
      const response = await apiClient.patch<EmailReceiptParser>(`${PARSERS}/${id}`, payload);
      return response.data;
    },

    remove: async (id: string): Promise<void> => {
      await apiClient.delete(`${PARSERS}/${id}`);
    },

    approve: async (id: string, expectedRevision?: number): Promise<EmailReceiptParser> => {
      const response = await apiClient.post<EmailReceiptParser>(
        `${PARSERS}/${id}/approve`,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      return response.data;
    },

    /**
     * Queue a request for the assistant (or an MCP agent) to write a parser from
     * 1 to 5 stored emails. No provider is called: the request waits, pending,
     * for whoever claims it by id; the draft it produces reads nothing until approved.
     * `kind: 'trade'` asks for a trade profile (trade confirmations); left out, a receipt profile.
     */
    draftWithAi: async (
      receiptIds: readonly string[],
      kind: 'receipt' | 'trade' = 'receipt',
    ): Promise<EmailReceiptParserDraftRequestResult> => {
      const response = await apiClient.post<EmailReceiptParserDraftRequestResult>(`${PARSERS}/draft-with-ai`, {
        receiptIds,
        ...(kind === 'trade' ? { kind } : {}),
      });
      return response.data;
    },

    /**
     * Run the assistant now over 1 to 5 emails paired with their transactions; it saves a
     * draft (or, with `parserId` and `feedback`, revises one). A run that saved no draft is a
     * 422 carrying the assistant's answer. Can take a minute. For a user whose AI is their own
     * agent it returns `{ status: 'queued', requestId }` at once (409 while the agent works on one).
     */
    generateWithAi: async (payload: GenerateParserWithAiPayload): Promise<GenerateParserWithAiResult> => {
      const response = await apiClient.post<GenerateParserWithAiResult>(`${PARSERS}/generate-with-ai`, payload, {
        timeout: 180_000,
      });
      return response.data;
    },

    /** Run a draft over the domain's emails, read-only: the selected samples and the newest others. */
    preview: async (id: string, payload: PreviewEmailReceiptParserPayload): Promise<ParserPreviewResult> => {
      const response = await apiClient.post<ParserPreviewResult>(`${PARSERS}/${id}/preview`, payload);
      return response.data;
    },

    /** Read a stored email with a definition that is not saved; writes nothing. */
    test: async (payload: TestEmailReceiptParserPayload): Promise<EmailReceiptParserTestResult> => {
      const response = await apiClient.post<EmailReceiptParserTestResult>(`${PARSERS}/test`, payload);
      return response.data;
    },
  },
};
