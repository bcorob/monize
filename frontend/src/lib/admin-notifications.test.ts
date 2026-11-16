import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { adminNotificationsApi } from './admin-notifications';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const CONFIG = {
  enabled: true,
  publicKey: 'PUB',
  configured: true,
  publicKeyFingerprint: 'abc123def4567890',
  generatedAt: '2026-08-01T10:00:00.000Z',
  liveSubscriptionCount: 2,
  disabledSubscriptionCount: 0,
};

describe('adminNotificationsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the instance channel configuration', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: CONFIG });

    const config = await adminNotificationsApi.getChannels();

    expect(apiClient.get).toHaveBeenCalledWith('/admin/notifications/channels');
    expect(config.publicKeyFingerprint).toBe('abc123def4567890');
    // The private half has no field on this shape, on the server or here.
    expect(Object.keys(config)).not.toContain('privateKey');
  });

  it('switches the Web Push channel through one boolean', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({
      data: { ...CONFIG, enabled: false },
    });

    const config = await adminNotificationsApi.setWebPushEnabled(false);

    expect(apiClient.patch).toHaveBeenCalledWith(
      '/admin/notifications/channels',
      { webPushEnabled: false },
    );
    expect(config.enabled).toBe(false);
  });

  it('returns how many devices a rotation retired', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { config: CONFIG, disabledSubscriptions: 4 },
    });

    const result = await adminNotificationsApi.rotateVapidKeys();

    expect(apiClient.post).toHaveBeenCalledWith(
      '/admin/notifications/vapid/rotate',
    );
    expect(result.disabledSubscriptions).toBe(4);
  });
});
