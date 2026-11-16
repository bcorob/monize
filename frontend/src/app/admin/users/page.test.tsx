import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import AdminUsersPage from './page';
import { authApi } from '@/lib/auth';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/admin/users',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', role: 'admin', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', role: 'admin', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

const mockGetUsers = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUserRole = vi.fn();
const mockUpdateUserStatus = vi.fn();
const mockResetUserPassword = vi.fn();
const mockResetUserTwoFactor = vi.fn();
const mockDeleteUser = vi.fn();
const mockUnlinkSso = vi.fn();
const mockGetUserStorage = vi.fn();

vi.mock('@/lib/admin', () => ({
  adminApi: {
    getUsers: (...args: any[]) => mockGetUsers(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    updateUserRole: (...args: any[]) => mockUpdateUserRole(...args),
    updateUserStatus: (...args: any[]) => mockUpdateUserStatus(...args),
    resetUserPassword: (...args: any[]) => mockResetUserPassword(...args),
    resetUserTwoFactor: (...args: any[]) => mockResetUserTwoFactor(...args),
    deleteUser: (...args: any[]) => mockDeleteUser(...args),
    unlinkSso: (...args: any[]) => mockUnlinkSso(...args),
    getUserStorage: (...args: any[]) => mockGetUserStorage(...args),
  },
}));

const mockGetSmtpStatus = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    getSmtpStatus: (...args: any[]) => mockGetSmtpStatus(...args),
  },
}));

vi.mock('@/components/admin/CreateUserModal', () => ({
  CreateUserModal: ({ isOpen, smtpConfigured, onClose, onCreated }: any) =>
    isOpen ? (
      <div data-testid="create-user-modal">
        <span>smtp:{String(smtpConfigured)}</span>
        <button
          onClick={() =>
            onCreated({
              email: 'made@example.com',
              firstName: 'Made',
              temporaryPassword: 'GenPass99!',
              invited: false,
              upgraded: false,
            })
          }
        >
          Created With Temp
        </button>
        <button
          onClick={() =>
            onCreated({ email: 'invited@example.com', invited: true, upgraded: false })
          }
        >
          Created With Invite
        </button>
        <button onClick={onClose}>Close Create</button>
      </div>
    ) : null,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}{actions}</div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, onConfirm, onCancel, confirmLabel }: any) => (
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null
  ),
}));

vi.mock('@/components/admin/ResetPasswordModal', () => ({
  ResetPasswordModal: ({ isOpen, temporaryPassword, userName, onClose }: any) => (
    isOpen ? (
      <div data-testid="reset-password-modal">
        <p>Password for {userName}: {temporaryPassword}</p>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  ),
}));

vi.mock('@/components/admin/UserManagementTable', () => ({
  UserManagementTable: ({ users, storage, currentUserId, oidcPasswordLogin, onChangeRole, onToggleStatus, onResetPassword, onUnlinkSso, onResetTwoFactor, onDeleteUser }: any) => (
    <div data-testid="user-table">
      <span data-testid="oidc-password-login">{String(oidcPasswordLogin)}</span>
      <span data-testid="storage-status">{storage.status}</span>
      {storage.status === 'ready' && (
        <span data-testid="storage-users">
          {[...storage.byUser.keys()].join(',')}
        </span>
      )}
      {users.map((user: any) => (
        <div key={user.id} data-testid={`user-row-${user.id}`}>
          <span>{user.email || user.firstName}</span>
          {user.id !== currentUserId && (
            <>
              <button onClick={() => onChangeRole(user, user.role === 'admin' ? 'user' : 'admin')}>
                {user.role === 'admin' ? 'Demote' : 'Promote'}
              </button>
              <button onClick={() => onToggleStatus(user)}>
                {user.isActive ? 'Disable' : 'Enable'}
              </button>
              <button onClick={() => onResetPassword(user)}>Reset Password</button>
              <button onClick={() => onUnlinkSso(user)}>Unlink SSO</button>
              <button onClick={() => onResetTwoFactor(user)}>Reset 2FA</button>
              <button onClick={() => onDeleteUser(user)}>Delete</button>
            </>
          )}
        </div>
      ))}
    </div>
  ),
}));

const mockUsers = [
  { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', authProvider: 'local', hasPassword: true, role: 'admin', isActive: true, mustChangePassword: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastLogin: '2026-02-14T00:00:00Z' },
  { id: 'user-1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', authProvider: 'local', hasPassword: true, role: 'user', isActive: true, mustChangePassword: false, createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', lastLogin: null },
  { id: 'user-2', email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', authProvider: 'oidc', hasPassword: false, role: 'user', isActive: false, mustChangePassword: false, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', lastLogin: null },
];

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsers.mockResolvedValue(mockUsers);
    mockGetSmtpStatus.mockResolvedValue({ configured: true });
    mockGetUserStorage.mockResolvedValue(
      mockUsers.map((user) => ({
        userId: user.id,
        backups: { enabled: true, artifacts: 3, bytes: 3000 },
        attachments: { files: 2, bytes: 200 },
      })),
    );
  });

  describe('SSO password login', () => {
    it('passes false to the table by default', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      expect(screen.getByTestId('oidc-password-login')).toHaveTextContent('false');
    });

    it('passes the server flag to the table when it is true', async () => {
      const methods = {
        local: true, oidc: true, registration: false, smtp: false, force2fa: false, demo: false,
      };
      vi.mocked(authApi.getAuthMethods).mockResolvedValue({ ...methods, oidcPasswordLogin: true } as any);
      render(<AdminUsersPage />);
      await waitFor(() =>
        expect(screen.getByTestId('oidc-password-login')).toHaveTextContent('true'),
      );
      vi.mocked(authApi.getAuthMethods).mockResolvedValue(methods as any);
    });
  });

  describe('Storage usage', () => {
    it('hands the table a reading keyed by user id', async () => {
      render(<AdminUsersPage />);

      await waitFor(() =>
        expect(screen.getByTestId('storage-status')).toHaveTextContent('ready'),
      );
      expect(screen.getByTestId('storage-users')).toHaveTextContent(
        'admin-id,user-1,user-2',
      );
    });

    it('reports its own failure without failing the user list', async () => {
      mockGetUserStorage.mockRejectedValue(new Error('store unreachable'));

      render(<AdminUsersPage />);

      await waitFor(() =>
        expect(screen.getByTestId('storage-status')).toHaveTextContent('error'),
      );
      // The rows are the other request's and are unaffected by it.
      expect(screen.getByTestId('user-row-user-1')).toBeInTheDocument();
    });

    it('re-reads the figures when an account is created, so the new row is covered', async () => {
      mockCreateUser.mockResolvedValue({});
      render(<AdminUsersPage />);
      await waitFor(() => expect(mockGetUserStorage).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByText('+ New User'));
      fireEvent.click(screen.getByText('Created With Invite'));

      await waitFor(() => expect(mockGetUserStorage).toHaveBeenCalledTimes(2));
    });
  });

  describe('Rendering', () => {
    it('renders page header with title', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    });

    it('renders within page layout', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('page-layout')).toBeInTheDocument());
    });

    it('shows user count in subtitle', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('3 users')).toBeInTheDocument());
    });

    it('shows singular user count', async () => {
      mockGetUsers.mockResolvedValue([mockUsers[0]]);
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('1 user')).toBeInTheDocument());
    });

    it('renders all users in the table', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
        expect(screen.getByText('alice@example.com')).toBeInTheDocument();
        expect(screen.getByText('bob@example.com')).toBeInTheDocument();
      });
    });

    it('does not show action buttons for current user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      const adminRow = screen.getByTestId('user-row-admin-id');
      expect(adminRow.querySelector('button')).toBeNull();
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner while loading', async () => {
      mockGetUsers.mockReturnValue(new Promise(() => {}));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument());
    });
  });

  describe('Role Management', () => {
    it('shows confirm dialog when promoting user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Promote')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Promote User/)).toBeInTheDocument();
      });
    });

    it('updates role on confirm', async () => {
      mockUpdateUserRole.mockResolvedValue({ ...mockUsers[1], role: 'admin' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Promote')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Promote to Admin'));
      await waitFor(() => expect(mockUpdateUserRole).toHaveBeenCalledWith('user-1', 'admin'));
    });
  });

  describe('User Status', () => {
    it('shows confirm dialog when disabling user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Disable')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Disable User\?/)).toBeInTheDocument();
      });
    });

    it('enables user without confirmation', async () => {
      mockUpdateUserStatus.mockResolvedValue({ ...mockUsers[2], isActive: true });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Enable'));
      await waitFor(() => expect(mockUpdateUserStatus).toHaveBeenCalledWith('user-2', true));
    });
  });

  describe('Password Reset', () => {
    it('shows confirm dialog before reset', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/temporary password for Alice/)).toBeInTheDocument();
      });
    });

    it('shows temporary password modal after reset', async () => {
      mockResetUserPassword.mockResolvedValue({ temporaryPassword: 'TempPass123!' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Reset Password', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => {
        expect(screen.getByTestId('reset-password-modal')).toBeInTheDocument();
        expect(screen.getByText(/TempPass123!/)).toBeInTheDocument();
      });
    });
  });

  describe('Unlink SSO', () => {
    it('confirms, unlinks, shows the temporary password and reloads the list', async () => {
      mockUnlinkSso.mockResolvedValue({ temporaryPassword: 'Tmp-pass-1' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());

      fireEvent.click(screen.getAllByText('Unlink SSO')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      expect(mockUnlinkSso).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Unlink SSO', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => expect(mockUnlinkSso).toHaveBeenCalledWith('user-1'));
      await waitFor(() =>
        expect(screen.getByTestId('reset-password-modal')).toHaveTextContent('Tmp-pass-1'),
      );
      await waitFor(() => expect(mockGetUsers).toHaveBeenCalledTimes(2));
    });

    it('reports a refusal as an error toast', async () => {
      mockUnlinkSso.mockRejectedValue(new Error('400'));
      const toast = await import('react-hot-toast');
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());

      fireEvent.click(screen.getAllByText('Unlink SSO')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Unlink SSO', { selector: '[data-testid="confirm-dialog"] button' }));

      await waitFor(() => expect(toast.default.error).toHaveBeenCalledWith('Failed to unlink SSO'));
      expect(screen.queryByTestId('reset-password-modal')).not.toBeInTheDocument();
    });
  });

  describe('Two-factor reset', () => {
    it('confirms, resets, reports success and reloads the list', async () => {
      mockResetUserTwoFactor.mockResolvedValue({ reset: true });
      const toast = await import('react-hot-toast');
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      expect(mockGetUsers).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getAllByText('Reset 2FA')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/switches off two-factor authentication for Alice/)).toBeInTheDocument();
      });
      expect(mockResetUserTwoFactor).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Reset 2FA', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => expect(mockResetUserTwoFactor).toHaveBeenCalledWith('user-1'));
      await waitFor(() =>
        expect(toast.default.success).toHaveBeenCalledWith(
          'Two-factor authentication was reset for Alice. They have been signed out.',
        ),
      );
      await waitFor(() => expect(mockGetUsers).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    it('reports a refusal (such as a user with no 2FA) as an error toast', async () => {
      mockResetUserTwoFactor.mockRejectedValue(new Error('400'));
      const toast = await import('react-hot-toast');
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());

      fireEvent.click(screen.getAllByText('Reset 2FA')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Reset 2FA', { selector: '[data-testid="confirm-dialog"] button' }));

      await waitFor(() =>
        expect(toast.default.error).toHaveBeenCalledWith(
          'Failed to reset two-factor authentication',
        ),
      );
    });
  });

  describe('User Deletion', () => {
    it('shows danger confirm dialog before deletion', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Delete User\?/)).toBeInTheDocument();
        expect(screen.getByText(/permanently remove/)).toBeInTheDocument();
      });
    });

    it('calls deleteUser on confirm', async () => {
      mockDeleteUser.mockResolvedValue(undefined);
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Delete User'));
      await waitFor(() => expect(mockDeleteUser).toHaveBeenCalledWith('user-1'));
    });
  });

  describe('Dialog cancel handlers', () => {
    it('closes confirm dialog when Cancel is clicked', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
    });

    it('closes reset password modal when Close is clicked', async () => {
      mockResetUserPassword.mockResolvedValue({ temporaryPassword: 'TempPass123!' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Reset Password', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => expect(screen.getByTestId('reset-password-modal')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Close'));
      await waitFor(() => {
        expect(screen.queryByTestId('reset-password-modal')).not.toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when delete user fails', async () => {
      const toast = await import('react-hot-toast');
      mockDeleteUser.mockRejectedValueOnce(new Error('Delete failed'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Delete User'));
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalled();
      });
    });

    it('shows error toast when loading users fails', async () => {
      const toast = await import('react-hot-toast');
      mockGetUsers.mockRejectedValue(new Error('Network error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(toast.default.error).toHaveBeenCalledWith('Failed to load users'));
    });

    it('shows error toast when enabling user fails', async () => {
      const toast = await import('react-hot-toast');
      mockUpdateUserStatus.mockRejectedValue(new Error('Server error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Enable'));
      await waitFor(() => expect(toast.default.error).toHaveBeenCalled());
    });

    it('shows error toast and reloads when role change fails', async () => {
      const toast = await import('react-hot-toast');
      mockUpdateUserRole.mockRejectedValue(new Error('Server error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Promote')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Promote to Admin'));
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalled();
        expect(mockGetUsers).toHaveBeenCalledTimes(2);
      });
    });

    it('shows error toast when disabling user fails', async () => {
      const toast = await import('react-hot-toast');
      mockUpdateUserStatus.mockRejectedValue(new Error('Server error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Disable')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Disable User'));
      await waitFor(() => expect(toast.default.error).toHaveBeenCalled());
    });

    it('shows error toast when password reset fails', async () => {
      const toast = await import('react-hot-toast');
      mockResetUserPassword.mockRejectedValue(new Error('Server error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Reset Password', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => expect(toast.default.error).toHaveBeenCalled());
    });
  });

  describe('Create User', () => {
    it('opens the create user modal from the New User button', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('+ New User'));
      await waitFor(() => expect(screen.getByTestId('create-user-modal')).toBeInTheDocument());
    });

    it('passes the SMTP status into the modal', async () => {
      mockGetSmtpStatus.mockResolvedValue({ configured: false });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('+ New User'));
      await waitFor(() => expect(screen.getByText('smtp:false')).toBeInTheDocument());
    });

    it('shows the temporary password modal and reloads after creation', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('+ New User'));
      await waitFor(() => expect(screen.getByTestId('create-user-modal')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Created With Temp'));
      await waitFor(() => {
        expect(screen.getByTestId('reset-password-modal')).toBeInTheDocument();
        expect(screen.getByText(/GenPass99!/)).toBeInTheDocument();
        expect(mockGetUsers).toHaveBeenCalledTimes(2);
      });
    });

    it('shows a success toast when an invite is sent', async () => {
      const toast = await import('react-hot-toast');
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('+ New User'));
      await waitFor(() => expect(screen.getByTestId('create-user-modal')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Created With Invite'));
      await waitFor(() =>
        expect(toast.default.success).toHaveBeenCalledWith(
          'Invite email sent to invited@example.com',
        ),
      );
    });
  });

  describe('Access Control', () => {
    it('successfully disables user on confirm', async () => {
      const toast = await import('react-hot-toast');
      mockUpdateUserStatus.mockResolvedValue({ ...mockUsers[1], isActive: false });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Disable')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Disable User'));
      await waitFor(() => {
        expect(mockUpdateUserStatus).toHaveBeenCalledWith('user-1', false);
        expect(toast.default.success).toHaveBeenCalled();
      });
    });
  });
});
