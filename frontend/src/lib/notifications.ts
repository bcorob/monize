import apiClient from './api';
import type {
  Notification,
  NotificationFilterCategory,
  NotificationSeverity,
} from '@/types/notification';

/**
 * The notification centre's endpoints.
 *
 * These lived on `budgetsApi` as `/budgets/alerts*` until the table stopped
 * being about budgets. Nothing here is cached: a notification list that is one
 * poll stale is a bell showing a count nobody can act on.
 */
export const notificationsApi = {
  list: async (unreadOnly = false): Promise<Notification[]> => {
    const response = await apiClient.get<Notification[]>('/notifications', {
      params: { unreadOnly },
    });
    return response.data;
  },

  markRead: async (id: string): Promise<Notification> => {
    const response = await apiClient.patch<Notification>(
      `/notifications/${id}/read`,
    );
    return response.data;
  },

  markAllRead: async (): Promise<{ updated: number }> => {
    const response = await apiClient.patch<{ updated: number }>(
      '/notifications/read-all',
    );
    return response.data;
  },

  dismiss: async (id: string): Promise<void> => {
    await apiClient.delete(`/notifications/${id}`);
  },

  /**
   * Dismisses every live notification matching the filter, server-side --
   * including rows beyond the list endpoint's 50-row window. The active filter
   * travels explicitly on the command, never as a list of on-screen ids.
   */
  dismissAll: async (filters: {
    severity?: NotificationSeverity;
    category?: NotificationFilterCategory;
  }): Promise<{ dismissed: number }> => {
    const response = await apiClient.delete<{ dismissed: number }>(
      '/notifications',
      {
        params: {
          ...(filters.severity ? { severity: filters.severity } : {}),
          ...(filters.category ? { category: filters.category } : {}),
        },
      },
    );
    return response.data;
  },
};
