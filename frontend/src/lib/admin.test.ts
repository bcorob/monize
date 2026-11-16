import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { adminApi } from './admin';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('adminApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getUsers fetches /admin/users', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'u-1' }] });
    const result = await adminApi.getUsers();
    expect(apiClient.get).toHaveBeenCalledWith('/admin/users');
    expect(result).toHaveLength(1);
  });

  it('getUserStorage fetches /admin/users/storage', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        {
          userId: 'u-1',
          backups: { enabled: true, artifacts: 3, bytes: 300 },
          attachments: { files: 2, bytes: 200 },
        },
      ],
    });

    const result = await adminApi.getUserStorage();

    expect(apiClient.get).toHaveBeenCalledWith('/admin/users/storage');
    // The unknown store's null travels as null rather than being coerced on
    // the way in -- the table needs to tell it apart from a stored zero.
    expect(result[0].backups.bytes).toBe(300);
  });

  it('carries an unreadable store through as null', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        {
          userId: 'u-1',
          backups: { enabled: true, artifacts: null, bytes: null },
          attachments: { files: 0, bytes: 0 },
        },
      ],
    });

    const [row] = await adminApi.getUserStorage();

    expect(row.backups.bytes).toBeNull();
    expect(row.attachments.bytes).toBe(0);
  });

  it('updateUserRole patches role', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'u-1', role: 'admin' } });
    const result = await adminApi.updateUserRole('u-1', 'admin');
    expect(apiClient.patch).toHaveBeenCalledWith('/admin/users/u-1/role', { role: 'admin' });
    expect(result.role).toBe('admin');
  });

  it('updateUserStatus patches status', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'u-1', isActive: false } });
    await adminApi.updateUserStatus('u-1', false);
    expect(apiClient.patch).toHaveBeenCalledWith('/admin/users/u-1/status', { isActive: false });
  });

  it('deleteUser calls DELETE /admin/users/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await adminApi.deleteUser('u-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/admin/users/u-1');
  });

  it('resetUserPassword posts to reset endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { temporaryPassword: 'abc123' } });
    const result = await adminApi.resetUserPassword('u-1');
    expect(apiClient.post).toHaveBeenCalledWith('/admin/users/u-1/reset-password');
    expect(result.temporaryPassword).toBe('abc123');
  });

  it('getDeploymentStatus reads the admin deployment status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { jwtSecretWeakness: 'placeholder' } });
    const result = await adminApi.getDeploymentStatus();
    expect(apiClient.get).toHaveBeenCalledWith('/admin/deployment-status');
    expect(result).toEqual({ jwtSecretWeakness: 'placeholder' });
  });

  it('resetUserTwoFactor posts to the reset-2fa endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { reset: true } });
    const result = await adminApi.resetUserTwoFactor('u-1');
    expect(apiClient.post).toHaveBeenCalledWith('/admin/users/u-1/reset-2fa');
    expect(result).toEqual({ reset: true });
  });

  it('unlinkSso posts to the unlink-sso endpoint and returns the temporary password', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { temporaryPassword: 'Tmp-pass-1' } });
    const result = await adminApi.unlinkSso('u-1');
    expect(apiClient.post).toHaveBeenCalledWith('/admin/users/u-1/unlink-sso');
    expect(result).toEqual({ temporaryPassword: 'Tmp-pass-1' });
  });

  it('createUser posts the payload to /admin/users', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { id: 'u-9', email: 'new@example.com', invited: true, upgraded: false },
    });
    const payload = { email: 'new@example.com', sendInvite: true, role: 'user' as const };
    const result = await adminApi.createUser(payload);
    expect(apiClient.post).toHaveBeenCalledWith('/admin/users', payload);
    expect(result.invited).toBe(true);
  });
});
