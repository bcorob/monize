import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import type {
  PayeeLookupKeyTestResult,
  PayeeLookupSettings,
  PayeeLookupStatus,
  UpdatePayeeLookupSettings,
} from '@/types/payee-lookup';

export const payeeLookupApi = {
  /**
   * Whether a contact lookup can run, and which source would answer.
   *
   * Read by every lookup surface through `useContactLookupAvailable`, so it is
   * cached and deduped exactly as `aiApi.getStatus` is: mounting the payee
   * form, the detail card and the transaction page costs one request. Both the
   * settings writes below and every AI provider mutation drop it, because the
   * answer depends on both sources.
   */
  getStatus: async (): Promise<PayeeLookupStatus> =>
    dedupe(
      'payee-lookup:status',
      async () =>
        (await apiClient.get<PayeeLookupStatus>('/payee-lookup/status')).data,
      60_000,
    ),

  getSettings: async (): Promise<PayeeLookupSettings> =>
    (await apiClient.get<PayeeLookupSettings>('/payee-lookup/settings')).data,

  updateSettings: async (
    data: UpdatePayeeLookupSettings,
  ): Promise<PayeeLookupSettings> => {
    const response = await apiClient.patch<PayeeLookupSettings>(
      '/payee-lookup/settings',
      data,
    );
    invalidateCache('payee-lookup:');
    return response.data;
  },

  /**
   * Check a key against Google. Costs a real request, which is why the server
   * throttles it and counts it against the month's quota.
   */
  testKey: async (apiKey?: string): Promise<PayeeLookupKeyTestResult> => {
    const response = await apiClient.post<PayeeLookupKeyTestResult>(
      '/payee-lookup/settings/test',
      apiKey ? { apiKey } : {},
    );
    invalidateCache('payee-lookup:');
    return response.data;
  },
};
