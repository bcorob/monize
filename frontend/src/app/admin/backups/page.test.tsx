import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import AdminBackupsPage from './page';

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
  usePathname: () => '/admin/backups',
  useSearchParams: () => new URLSearchParams(),
}));

let currentRole = 'admin';
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'admin-id', email: 'a@example.com', role: currentRole },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'admin-id', email: 'a@example.com', role: currentRole },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = { preferences: { timezone: 'UTC' } };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

const mockUseDemoMode = vi.fn(() => false);
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

// AutoBackupSection self-fetches on mount; give it settled, empty answers so
// the admin page renders without touching the network.
vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    getAutoBackupSettings: vi.fn(() =>
      Promise.resolve({
        userId: 'admin-id',
        enabled: false,
        folderPath: '',
        frequency: 'daily',
        backupTime: '02:00',
        timezone: 'UTC',
        retentionDaily: 7,
        retentionWeekly: 4,
        retentionMonthly: 6,
        lastBackupAt: null,
        lastBackupStatus: null,
        lastBackupError: null,
        nextBackupAt: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      }),
    ),
    getAutoBackupCapability: vi.fn(() =>
      Promise.resolve({ available: true, folderPath: '/data/backups' }),
    ),
    updateAutoBackupSettings: vi.fn(),
    validateFolder: vi.fn(),
    browseFolders: vi.fn(),
    runAutoBackup: vi.fn(),
  },
}));

describe('AdminBackupsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRole = 'admin';
    mockUseDemoMode.mockReturnValue(false);
  });

  it('shows the page and the "not a full database backup" explanation to an admin', async () => {
    render(<AdminBackupsPage />);

    await waitFor(() => {
      expect(screen.getByText('Not a full database backup')).toBeInTheDocument();
    });
    // The scope copy must explicitly say what it is not, and -- since the
    // policy now governs the whole instance -- whose data it covers.
    expect(screen.getByText(/not a PostgreSQL dump/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Every active account is covered/i),
    ).toBeInTheDocument();
    // And it renders the automatic-backup configuration below the explanation.
    expect(
      screen.getByText('Automatic Backup', { selector: 'h2' }),
    ).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('renders the demo banner in demo mode', async () => {
    mockUseDemoMode.mockReturnValue(true);
    render(<AdminBackupsPage />);

    await waitFor(() => {
      expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Automatic-backup configuration is disabled in demo mode/i),
    ).toBeInTheDocument();
    // The scope card still renders alongside the banner.
    expect(screen.getByText('Not a full database backup')).toBeInTheDocument();
  });

  it('does not render the demo banner outside demo mode', async () => {
    render(<AdminBackupsPage />);

    await waitFor(() => {
      expect(screen.getByText('Not a full database backup')).toBeInTheDocument();
    });
    expect(screen.queryByText('Restricted in Demo Mode')).toBeNull();
  });

  it('redirects a non-admin away and renders nothing', async () => {
    currentRole = 'user';
    const { container } = render(<AdminBackupsPage />);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
    expect(screen.queryByText('Not a full database backup')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
