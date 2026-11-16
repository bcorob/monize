import apiClient from './api';
import type { AiReviewApproveBatchResult, AiReviewFilter, AiReviewItem } from '@/types/ai-review';

/**
 * The review inbox. Deliberately uncached: the queue changes under the page
 * (an agent claims, proposes, an expiry cron runs), so a list served from a
 * cache would offer an Approve for a request that is no longer open.
 *
 * Approval is not here. A proposal is a signed pending action and is committed
 * by `aiApi.confirmAction`, the same client the chat uses.
 */
export const aiReviewApi = {
  /** `open` sends no status: the server answers what is waiting plus expired. */
  list: async (filter: AiReviewFilter): Promise<AiReviewItem[]> => {
    const response = await apiClient.get<AiReviewItem[]>('/ai-review-requests', {
      params: filter === 'open' ? undefined : { status: filter },
    });
    return response.data;
  },

  /**
   * Approve up to 100 proposals, one after the other, through the same confirm a
   * single approval uses (each rebuilt against its transaction as it is now). One
   * result per id; nothing is partly written.
   */
  approveBatch: async (ids: readonly string[]): Promise<AiReviewApproveBatchResult> => {
    const response = await apiClient.post<AiReviewApproveBatchResult>('/ai-review-requests/approve-batch', { ids });
    return response.data;
  },

  dismiss: async (id: string): Promise<AiReviewItem> => {
    const response = await apiClient.post<AiReviewItem>(`/ai-review-requests/${id}/dismiss`);
    return response.data;
  },
};
