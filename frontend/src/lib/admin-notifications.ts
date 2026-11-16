import apiClient from './api';
import type { PushConfig } from './push';

/**
 * The administrator's view of this instance's push identity.
 *
 * The public key is here because it is public by construction -- every browser
 * that subscribes is handed it. The private half exists only on the server and
 * has no field on any shape the API returns; a backend guard spec fails if one
 * ever appears.
 */
export interface AdminPushConfig extends PushConfig {
  publicKeyFingerprint: string | null;
  generatedAt: string | null;
  liveSubscriptionCount: number;
  disabledSubscriptionCount: number;
}

export interface RotateVapidResult {
  config: AdminPushConfig;
  /** Devices this rotation retired. Every one of them must subscribe again. */
  disabledSubscriptions: number;
}

export const adminNotificationsApi = {
  getChannels: async (): Promise<AdminPushConfig> => {
    const response = await apiClient.get<AdminPushConfig>(
      '/admin/notifications/channels',
    );
    return response.data;
  },

  setWebPushEnabled: async (
    webPushEnabled: boolean,
  ): Promise<AdminPushConfig> => {
    const response = await apiClient.patch<AdminPushConfig>(
      '/admin/notifications/channels',
      { webPushEnabled },
    );
    return response.data;
  },

  rotateVapidKeys: async (): Promise<RotateVapidResult> => {
    const response = await apiClient.post<RotateVapidResult>(
      '/admin/notifications/vapid/rotate',
    );
    return response.data;
  },
};
