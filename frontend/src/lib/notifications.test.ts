import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { notificationsApi } from './notifications';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('notificationsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists every live notification by default', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await notificationsApi.list();

    expect(apiClient.get).toHaveBeenCalledWith('/notifications', {
      params: { unreadOnly: false },
    });
  });

  // The bell polls this one, and the server does not materialize bill reminders
  // for it -- a read endpoint must not write on the hot path.
  it('asks for unread only when told to', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await notificationsApi.list(true);

    expect(apiClient.get).toHaveBeenCalledWith('/notifications', {
      params: { unreadOnly: true },
    });
  });

  it('marks one read', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'n-1' } });

    await notificationsApi.markRead('n-1');

    expect(apiClient.patch).toHaveBeenCalledWith('/notifications/n-1/read');
  });

  it('marks all read and reports the count', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { updated: 3 } });

    await expect(notificationsApi.markAllRead()).resolves.toEqual({
      updated: 3,
    });
    expect(apiClient.patch).toHaveBeenCalledWith('/notifications/read-all');
  });

  it('dismisses one', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});

    await notificationsApi.dismiss('n-1');

    expect(apiClient.delete).toHaveBeenCalledWith('/notifications/n-1');
  });

  describe('dismissAll', () => {
    // The filter travels on the command, so the server dismisses exactly what
    // the user saw matching -- including rows past the list's 50-row window.
    it('sends the active filter', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: { dismissed: 4 } });

      await expect(
        notificationsApi.dismissAll({
          severity: 'critical',
          category: 'system',
        }),
      ).resolves.toEqual({ dismissed: 4 });
      expect(apiClient.delete).toHaveBeenCalledWith('/notifications', {
        params: { severity: 'critical', category: 'system' },
      });
    });

    // An omitted dimension means "no restriction on that dimension", so it must
    // not travel as a parameter at all: `severity=undefined` on the wire would
    // be a filter the user did not set.
    it('omits a dimension the user did not filter', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: { dismissed: 9 } });

      await notificationsApi.dismissAll({});

      expect(apiClient.delete).toHaveBeenCalledWith('/notifications', {
        params: {},
      });
    });
  });
});
