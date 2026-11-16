import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import LoginPage from './page';
import toast from 'react-hot-toast';

// Mock the auth API module
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    }),
    login: vi.fn(),
    initiateOidc: vi.fn(),
    resendVerification: vi.fn(),
  },
  AuthMethods: {},
}));

// Mock the auth store
const mockLogin = vi.fn();
const authState: {
  login: typeof mockLogin;
  isAuthenticated: boolean;
  _hasHydrated: boolean;
  user: Record<string, unknown> | null;
} = { login: mockLogin, isAuthenticated: false, _hasHydrated: true, user: null };
vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn((selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
  ),
}));

// Mock the logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Module-level state for TwoFactorVerify mock user
const twoFactorUser = {
  id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User',
  role: 'user', hasPassword: true, mustChangePassword: false,
};

// How the mock TwoFactorVerify reports the sign-in was completed.
let twoFactorDetails: { usedBackupCode: boolean; backupCodesRemaining: number | null } = {
  usedBackupCode: false,
  backupCodesRemaining: null,
};

// Mock TwoFactorVerify
vi.mock('@/components/auth/TwoFactorVerify', () => ({
  TwoFactorVerify: ({ onVerified, onCancel }: any) => (
    <div data-testid="two-factor-verify">
      TwoFactorVerify
      <button data-testid="verify-2fa" onClick={() => onVerified({ ...twoFactorUser }, { ...twoFactorDetails })}>Verify</button>
      <button data-testid="cancel-2fa" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

// Import mocked modules to control them
import { authApi } from '@/lib/auth';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockReturnTo: string | null = null;
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/login',
  useSearchParams: () => ({ get: (key: string) => key === 'returnTo' ? mockReturnTo : null }),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockClear();
    mockReturnTo = null;
    authState.isAuthenticated = false;
    authState._hasHydrated = true;
    authState.user = null;
    twoFactorUser.mustChangePassword = false;
    twoFactorDetails = { usedBackupCode: false, backupCodesRemaining: null };
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });
  });

  it('renders the sign in heading', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText('Sign in to Monize')).toBeInTheDocument();
    });
  });

  it('renders email and password fields', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    });
  });

  it('renders sign in button', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it('renders registration link when enabled', async () => {
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/create a new account/i)).toBeInTheDocument();
    });
  });

  it('shows loading state initially', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
  });

  it('renders SSO-only mode when only OIDC is available', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: true,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/Single Sign-On/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });
  });

  it('shows error message when no auth methods configured', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: false,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/no authentication methods/i)).toBeInTheDocument();
    });
  });

  it('shows OIDC button alongside form when both are enabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });
  });

  it('shows forgot password link when SMTP is enabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: true,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/forgot your password/i)).toBeInTheDocument();
    });
  });

  it('does not show forgot password link when SMTP is disabled', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/forgot your password/i)).not.toBeInTheDocument();
  });

  it('does not show registration link when registration is disabled', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: false,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/create a new account/i)).not.toBeInTheDocument();
  });

  it('submits login form with valid credentials and redirects to dashboard', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false };
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith({ email: 'test@example.com', password: 'password123', rememberMe: false });
    });

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(mockUser, 'httpOnly');
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('redirects to change-password when mustChangePassword is true', async () => {
    const mockUser = { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: true };
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/change-password');
    });
  });

  it('shows error toast on login failure', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Invalid credentials'));

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Invalid email or password');
    });
  });

  it('shows 2FA verify when login requires 2FA', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-token-123' });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-verify')).toBeInTheDocument();
    });
  });

  it('shows the verify-your-email prompt and resends when login is unverified', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ emailNotVerified: true });
    (authApi.resendVerification as ReturnType<typeof vi.fn>).mockResolvedValue({ message: 'ok' });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'unverified@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Verify your email')).toBeInTheDocument();
    });
    expect(mockLogin).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /resend verification email/i }));
    });

    await waitFor(() => {
      expect(authApi.resendVerification).toHaveBeenCalledWith('unverified@example.com');
    });
  });

  it('renders remember me checkbox', async () => {
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/remember me/i)).toBeInTheDocument();
    });
  });

  it('shows Or continue with text when OIDC is enabled alongside local', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true,
      oidc: true,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/Or continue with/i)).toBeInTheDocument();
    });
  });

  it('calls initiateOidc when SSO button is clicked in SSO-only mode', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: false,
      oidc: true,
      registration: false,
      smtp: false,
      force2fa: false, demo: false,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with sso/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in with sso/i }));
    expect(authApi.initiateOidc).toHaveBeenCalled();
  });

  it('renders the version number as a button that opens the What\'s New modal', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.11.0');
    render(<LoginPage />);
    const button = await screen.findByRole('button', { name: 'v1.11.0' });
    expect(button).toHaveAttribute('title', 'View release notes for v1.11.0');
    vi.unstubAllEnvs();
  });

  it('shows loading indicator while fetching auth methods', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<LoginPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('uses window.location.href for returnTo redirect after successful login', async () => {
    mockReturnTo = '/bills';
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
    });

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });

    await waitFor(() => {
      // With a valid returnTo, router.push('/dashboard') should NOT be called
      // (window.location.href is used instead for the redirect)
      expect(mockPush).not.toHaveBeenCalledWith('/dashboard');
    });
  });

  it('shows demo welcome toast in demo mode', async () => {
    (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: true,
    });
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
    });

    render(<LoginPage />);
    // In demo mode the button text is "Try Demo", not "Sign in"
    // Wait for demo credentials to be pre-filled by the useEffect
    await waitFor(() => {
      const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement;
      expect(emailInput.value).toBe('demo@monize.com');
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try demo/i }));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('Demo'),
        expect.any(Object),
      );
    });
  });

  it('cancels 2FA and returns to login form', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-token-123' });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(screen.getByTestId('two-factor-verify')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('cancel-2fa'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-verify')).not.toBeInTheDocument();
    });
  });

  it('completes login after 2FA verification', async () => {
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-token-123' });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(screen.getByTestId('two-factor-verify')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('verify-2fa'));
    });
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
    });
  });

  it('redirects to change-password after 2FA when mustChangePassword', async () => {
    twoFactorUser.mustChangePassword = true;
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-123' });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(screen.getByTestId('verify-2fa')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('verify-2fa'));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/change-password');
    });
  });

  describe('after a sign-in completed with a backup code', () => {
    const signInThrough2FA = async () => {
      (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({ requires2FA: true, tempToken: 'temp-123' });
      render(<LoginPage />);
      await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
        fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
      });
      await waitFor(() => expect(screen.getByTestId('verify-2fa')).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByTestId('verify-2fa'));
      });
    };

    it('goes to the 2FA controls in Settings > Security, ignoring returnTo', async () => {
      mockReturnTo = '/bills';
      twoFactorDetails = { usedBackupCode: true, backupCodesRemaining: 2 };
      const hrefBefore = window.location.href;

      await signInThrough2FA();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/settings#two-factor');
      });
      expect(mockPush).not.toHaveBeenCalledWith('/dashboard');
      expect(window.location.href).toBe(hrefBefore);
      expect(mockLogin).toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        'You signed in with a backup code (2 left). If your authenticator is lost, exposed or no longer works, use Reset 2FA here to set up a new one.',
        expect.objectContaining({ duration: expect.any(Number) }),
      );
    });

    it('says so when that was the last backup code', async () => {
      twoFactorDetails = { usedBackupCode: true, backupCodesRemaining: 0 };

      await signInThrough2FA();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/settings#two-factor');
      });
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining('your last backup code'),
        expect.anything(),
      );
    });

    it('still sends a user who must change their password there first', async () => {
      twoFactorUser.mustChangePassword = true;
      twoFactorDetails = { usedBackupCode: true, backupCodesRemaining: 2 };

      await signInThrough2FA();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/change-password');
      });
      expect(mockPush).not.toHaveBeenCalledWith('/settings#two-factor');
    });

    it('leaves an authenticator-code sign-in on its usual route', async () => {
      twoFactorDetails = { usedBackupCode: false, backupCodesRemaining: null };

      await signInThrough2FA();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard');
      });
      expect(mockPush).not.toHaveBeenCalledWith('/settings#two-factor');
      expect(toast).not.toHaveBeenCalled();
    });
  });

  it('safeReturnTo rejects absolute URLs', async () => {
    mockReturnTo = 'http://evil.com';
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
    });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => {
      // Should redirect to /dashboard, not evil.com
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('safeReturnTo rejects protocol-relative URLs (//)', async () => {
    mockReturnTo = '//evil.com';
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
    });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('safeReturnTo accepts valid path and skips router.push', async () => {
    mockReturnTo = '/transactions';
    (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
    });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => {
      // Valid returnTo means window.location.href is used, not router.push('/dashboard')
      expect(mockPush).not.toHaveBeenCalledWith('/dashboard');
    });
  });

  describe('returnTo that leaves the origin', () => {
    // `?returnTo=%2F%09%2Fevil.example` decodes to "/<tab>/evil.example": it
    // passes a prefix check, and the URL parser reads it as //evil.example.
    it.each([
      ['tab', '/\t/evil.example'],
      ['CR', '/\r/evil.example'],
      ['LF', '/\n/evil.example'],
      ['backslash', '/\\evil.example'],
      ['protocol-relative', '//evil.example'],
      ['absolute URL', 'https://evil.example/'],
    ])('is ignored after a password sign-in (%s)', async (_label, value) => {
      mockReturnTo = value;
      (authApi.login as ReturnType<typeof vi.fn>).mockResolvedValue({
        user: { id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, mustChangePassword: false },
      });
      render(<LoginPage />);
      await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
        fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password123' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
      });
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard');
      });
    });

    it('is not stashed for the OIDC callback', async () => {
      mockReturnTo = '/\t/evil.example';
      sessionStorage.removeItem('postLoginReturnTo');
      (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
        local: false, oidc: true, registration: false, smtp: false, force2fa: false, demo: false,
      });
      render(<LoginPage />);
      const sso = await screen.findByRole('button', { name: /sign in with sso/i });
      await act(async () => {
        fireEvent.click(sso);
      });
      expect(authApi.initiateOidc).toHaveBeenCalled();
      expect(sessionStorage.getItem('postLoginReturnTo')).toBeNull();
    });

    it('stashes a same-origin returnTo with its query string for the OIDC callback', async () => {
      mockReturnTo = '/api/v1/oauth-consent/abc?x=1';
      (authApi.getAuthMethods as ReturnType<typeof vi.fn>).mockResolvedValue({
        local: false, oidc: true, registration: false, smtp: false, force2fa: false, demo: false,
      });
      render(<LoginPage />);
      const sso = await screen.findByRole('button', { name: /sign in with sso/i });
      await act(async () => {
        fireEvent.click(sso);
      });
      expect(sessionStorage.getItem('postLoginReturnTo')).toBe(
        '/api/v1/oauth-consent/abc?x=1',
      );
      sessionStorage.removeItem('postLoginReturnTo');
    });
  });

  describe('a session restored on /login', () => {
    const originalLocation = window.location;
    const restoredUser = {
      id: 'u1', email: 'test@example.com', firstName: 'Test', lastName: 'User',
      role: 'user', hasPassword: true, mustChangePassword: false,
    };

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    });

    function restoreSession(overrides: Partial<typeof restoredUser> = {}) {
      authState.isAuthenticated = true;
      authState._hasHydrated = true;
      authState.user = { ...restoredUser, ...overrides };
    }

    it('leaves for the dashboard without showing the form', async () => {
      restoreSession();
      render(<LoginPage />);
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
      expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    });

    it('leaves for change-password when the password must change', async () => {
      restoreSession({ mustChangePassword: true });
      mockReturnTo = '/bills';
      render(<LoginPage />);
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/change-password'));
      expect(mockReplace).not.toHaveBeenCalledWith('/dashboard');
    });

    it('leaves for a safe returnTo with a full-page navigation', async () => {
      const replace = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, replace },
        writable: true,
        configurable: true,
      });
      restoreSession();
      mockReturnTo = '/api/v1/oauth-consent/abc?x=1';
      render(<LoginPage />);
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/api/v1/oauth-consent/abc?x=1'));
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('ignores an unsafe returnTo and leaves for the dashboard', async () => {
      restoreSession();
      mockReturnTo = '//evil.example';
      render(<LoginPage />);
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
    });

    it('holds the form back and does not redirect while the profile is loading', async () => {
      authState.isAuthenticated = true;
      authState._hasHydrated = false;
      render(<LoginPage />);
      await waitFor(() => expect(authApi.getAuthMethods).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('shows the form when hydrated without a profile (backend unreachable)', async () => {
      authState.isAuthenticated = true;
      authState._hasHydrated = true;
      authState.user = null;
      render(<LoginPage />);
      await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('shows the form and does not redirect when signed out', async () => {
      render(<LoginPage />);
      await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
