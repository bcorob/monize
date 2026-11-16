import apiClient from './api';
import { AdminUser } from '@/types/auth';

export interface ResetPasswordResponse {
  temporaryPassword: string;
}

export interface CreateUserPayload {
  email: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  sendInvite?: boolean;
  role?: 'admin' | 'user';
}

export interface CreateUserResponse extends AdminUser {
  temporaryPassword?: string;
  invited: boolean;
  upgraded: boolean;
}

/**
 * How much of the backup store one user's automatic backups occupy.
 *
 * `artifacts` and `bytes` are `null` together, and only when the server could
 * not enumerate the store at all -- a misconfigured backup root, an object
 * store that refused the listing. That is not the same as a user with nothing
 * stored, who enumerates fine and answers `0`, so the table renders the two
 * differently rather than printing "0 bytes" over an answer nobody obtained.
 *
 * `enabled` is the schedule as it stands now: a user switched off last week
 * still occupies whatever their retention window has not aged out.
 */
export interface AdminBackupStorage {
  enabled: boolean;
  artifacts: number | null;
  bytes: number | null;
}

/**
 * How much one user's attachments occupy. Never null: the figures are a COUNT
 * and a SUM over the metadata rows that record each file's size, so they are
 * complete whichever provider holds the bytes, and an account with no
 * attachments genuinely stores zero.
 */
export interface AdminAttachmentStorage {
  files: number;
  bytes: number;
}

export interface AdminUserStorage {
  userId: string;
  backups: AdminBackupStorage;
  attachments: AdminAttachmentStorage;
}

/**
 * Deployment configuration an administrator has to fix, from the admin-only
 * `GET /admin/deployment-status`. Reason codes only: the server never sends
 * the secret, or anything derived from it.
 */
export interface DeploymentStatus {
  /** Why JWT_SECRET is weak, or `null` when it is not. */
  jwtSecretWeakness: 'placeholder' | 'predictable' | null;
}

export const adminApi = {
  getDeploymentStatus: async (): Promise<DeploymentStatus> => {
    const response = await apiClient.get<DeploymentStatus>(
      '/admin/deployment-status',
    );
    return response.data;
  },

  getUsers: async (): Promise<AdminUser[]> => {
    const response = await apiClient.get<AdminUser[]>('/admin/users');
    return response.data;
  },

  /**
   * Per-user storage usage, deliberately separate from `getUsers`: it
   * enumerates the backup store once per user, which on an S3 target is a round
   * trip each, so the user list renders first and the two storage columns fill
   * in when this answers.
   */
  getUserStorage: async (): Promise<AdminUserStorage[]> => {
    const response = await apiClient.get<AdminUserStorage[]>(
      '/admin/users/storage',
    );
    return response.data;
  },

  createUser: async (
    payload: CreateUserPayload,
  ): Promise<CreateUserResponse> => {
    const response = await apiClient.post<CreateUserResponse>(
      '/admin/users',
      payload,
    );
    return response.data;
  },

  updateUserRole: async (
    userId: string,
    role: 'admin' | 'user',
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/role`,
      { role },
    );
    return response.data;
  },

  updateUserStatus: async (
    userId: string,
    isActive: boolean,
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/status`,
      { isActive },
    );
    return response.data;
  },

  deleteUser: async (userId: string): Promise<{ downgraded: boolean }> => {
    const response = await apiClient.delete<{ downgraded: boolean }>(
      `/admin/users/${userId}`,
    );
    return response.data;
  },

  resetUserPassword: async (
    userId: string,
  ): Promise<ResetPasswordResponse> => {
    const response = await apiClient.post<ResetPasswordResponse>(
      `/admin/users/${userId}/reset-password`,
    );
    return response.data;
  },

  /** Convert an SSO account to a local one; returns its temporary password. */
  unlinkSso: async (userId: string): Promise<ResetPasswordResponse> => {
    const response = await apiClient.post<ResetPasswordResponse>(
      `/admin/users/${userId}/unlink-sso`,
    );
    return response.data;
  },

  /**
   * Switch a user's two-factor authentication off so they can sign in with
   * their password and enroll again: clears their TOTP secret and backup codes,
   * deletes their trusted devices and signs them out. Refused (400) for a user
   * with no 2FA set up, and (403) for the calling admin themself.
   */
  resetUserTwoFactor: async (userId: string): Promise<{ reset: true }> => {
    const response = await apiClient.post<{ reset: true }>(
      `/admin/users/${userId}/reset-2fa`,
    );
    return response.data;
  },
};
