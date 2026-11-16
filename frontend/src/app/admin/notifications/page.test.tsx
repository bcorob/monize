import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import AdminNotificationsPage from './page';

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

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
  usePathname: () => '/admin/notifications',
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
    const state = {
      preferences: { theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false,
      demo: false,
    }),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

const mockGetChannels = vi.fn();
const mockSetWebPushEnabled = vi.fn();
const mockRotate = vi.fn();
vi.mock('@/lib/admin-notifications', () => ({
  adminNotificationsApi: {
    getChannels: (...args: any[]) => mockGetChannels(...args),

    setWebPushEnabled: (...args: any[]) => mockSetWebPushEnabled(...args),

    rotateVapidKeys: (...args: any[]) => mockRotate(...args),
  },
}));

const mockGetSmtpStatus = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    getSmtpStatus: (...args: any[]) => mockGetSmtpStatus(...args),
  },
}));

const CONFIGURED = {
  enabled: true,
  publicKey: 'PUB',
  configured: true,
  keyUnreadable: false,
  publicKeyFingerprint: 'abc123def4567890',
  generatedAt: '2026-08-01T10:00:00.000Z',
  liveSubscriptionCount: 3,
  disabledSubscriptionCount: 1,
};

describe('AdminNotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRole = 'admin';
    mockGetChannels.mockResolvedValue(CONFIGURED);
    mockGetSmtpStatus.mockResolvedValue({ configured: true });
  });

  it('lists every channel this deployment could offer', async () => {
    render(<AdminNotificationsPage />);

    await waitFor(() => expect(mockGetChannels).toHaveBeenCalled());
    expect(await screen.findByText('In-app notifications')).toBeInTheDocument();
    expect(screen.getByText('Browser push')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('ntfy and UnifiedPush')).toBeInTheDocument();
  });

  describe('the email channel state', () => {
    /**
     * Three states, and the pill used to draw two. `null` is "the status could
     * not be read", and rendering it as "Unavailable" contradicted the note
     * printed right beside it -- so the page asserted SMTP was not configured
     * while also saying it did not know.
     */
    it.each([
      [{ configured: true }, 'On'],
      [{ configured: false }, 'Unavailable'],
    ])('reads %o as %s', async (status, label) => {
      mockGetSmtpStatus.mockResolvedValue(status);

      render(<AdminNotificationsPage />);

      await waitFor(() => expect(screen.getByText('Email')).toBeInTheDocument());
      await waitFor(() =>
        expect(screen.getAllByText(label).length).toBeGreaterThan(0),
      );
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });

    it('says it does not know when the status cannot be read', async () => {
      mockGetSmtpStatus.mockRejectedValue(new Error('down'));

      render(<AdminNotificationsPage />);

      await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
      // And not the verdict it does not have: "Unavailable" belongs to a read
      // that came back saying SMTP is not configured.
      expect(
        screen.queryByText('Email is not configured on this deployment.'),
      ).not.toBeInTheDocument();
    });
  });

  it('shows the key fingerprint and device counts, never a private key', async () => {
    render(<AdminNotificationsPage />);

    expect(await screen.findByText('abc123def4567890')).toBeInTheDocument();
    expect(screen.getByText('3 active, 1 retired')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('privateKey');
  });

  // A failed read is not an instance with push switched off. Rendering the
  // panel from a null config would show an operator a state the server never
  // reported, and send them to flip a switch that is not the problem.
  it('says the settings could not be read rather than drawing them as off', async () => {
    mockGetChannels.mockRejectedValue(new Error('boom'));

    render(<AdminNotificationsPage />);

    expect(
      await screen.findByText(/could not read the notification settings/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Browser push')).not.toBeInTheDocument();
  });

  it('reports an unavailable mail-server status separately from SMTP being off', async () => {
    mockGetSmtpStatus.mockRejectedValue(new Error('boom'));

    render(<AdminNotificationsPage />);

    expect(
      await screen.findByText(/could not read the mail server status/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No mail server is configured/i),
    ).not.toBeInTheDocument();
  });

  it('tells an operator what to set when the instance has no key pair', async () => {
    mockGetChannels.mockResolvedValue({
      ...CONFIGURED,
      enabled: false,
      configured: false,
      publicKey: null,
      publicKeyFingerprint: null,
      generatedAt: null,
    });

    render(<AdminNotificationsPage />);

    expect(
      await screen.findByText(/ENCRYPTION_KEY is not set/i),
    ).toBeInTheDocument();
  });

  // Three states, three repairs. A key pair this server cannot decrypt reports
  // itself as a healthy channel unless it is its own state: the column is
  // populated, every "is push configured?" check says yes, and only the send
  // fails -- so an administrator has no reason to rotate, which is the one fix.
  it('names an unreadable key pair as its own problem, not as push being off', async () => {
    mockGetChannels.mockResolvedValue({
      ...CONFIGURED,
      enabled: false,
      configured: true,
      keyUnreadable: true,
      encryptionAvailable: true,
    });

    render(<AdminNotificationsPage />);

    expect(
      await screen.findByText(/cannot decrypt its stored push key pair/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/ENCRYPTION_KEY is not set/i),
    ).not.toBeInTheDocument();
    // Rotation is the repair, so it stays offered; the kill-switch is not.
    expect(
      screen.getByRole('button', { name: /rotate key pair/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('switch', {
        name: /enable browser push for this instance/i,
      }),
    ).toBeDisabled();
  });

  // The same state, the other cause -- and the repairs are opposites. Rotation
  // needs a key to store the new private half under, so `rotateKeyPair` refuses
  // outright when ENCRYPTION_KEY is missing: telling this operator to rotate is
  // an instruction that cannot succeed, and the one that can (set the variable,
  // restart) is not a button on any page.
  it('sends the operator to the variable, not to the rotate button, when no key is set', async () => {
    mockGetChannels.mockResolvedValue({
      ...CONFIGURED,
      enabled: false,
      configured: true,
      keyUnreadable: true,
      encryptionAvailable: false,
    });

    render(<AdminNotificationsPage />);

    // Both surfaces on this page say it: the channel row's note and the identity
    // panel's. Neither may keep the rotate wording, which is why the second
    // assertion is the one that matters.
    expect(
      (await screen.findAllByText(/ENCRYPTION_KEY/i)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.queryByText(/Rotate the key pair below to recover/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/cannot decrypt its stored push key pair/i),
    ).not.toBeInTheDocument();
  });

  it('switches the instance channel off through the toggle', async () => {
    mockSetWebPushEnabled.mockResolvedValue({ ...CONFIGURED, enabled: false });
    render(<AdminNotificationsPage />);

    const toggle = await screen.findByRole('switch', {
      name: /enable browser push for this instance/i,
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockSetWebPushEnabled).toHaveBeenCalledWith(false),
    );
  });

  // Rotation retires every registered device, so it asks first and says how
  // many devices the operator is about to disconnect.
  it('confirms a rotation, naming how many devices it will retire', async () => {
    mockRotate.mockResolvedValue({
      config: { ...CONFIGURED, publicKeyFingerprint: 'newfingerprint00' },
      disabledSubscriptions: 3,
    });
    render(<AdminNotificationsPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /rotate key pair/i }),
    );

    expect(
      await screen.findByText(/3 registered devices will stop/i),
    ).toBeInTheDocument();
    expect(mockRotate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }));

    await waitFor(() => expect(mockRotate).toHaveBeenCalled());
    expect(await screen.findByText('newfingerprint00')).toBeInTheDocument();
  });

  it('does not rotate when the operator cancels', async () => {
    render(<AdminNotificationsPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /rotate key pair/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/registered devices will stop/i),
      ).not.toBeInTheDocument(),
    );
    expect(mockRotate).not.toHaveBeenCalled();
  });

  // The page configures the instance. Devices, test sends and preferences are
  // each account's own, and an administrator has no route to another person's.
  it('sends nothing and lists nobody: it points at each account instead', async () => {
    render(<AdminNotificationsPage />);

    await screen.findByText('Browser push');
    expect(
      screen.queryByRole('button', { name: /send test/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/belong to each account/i)).toBeInTheDocument();
  });

  it('sends a non-admin away instead of rendering', async () => {
    currentRole = 'user';

    render(<AdminNotificationsPage />);

    await waitFor(() =>
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard'),
    );
    expect(mockGetChannels).not.toHaveBeenCalled();
  });
});
