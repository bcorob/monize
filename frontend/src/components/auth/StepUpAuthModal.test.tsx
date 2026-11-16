import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { StepUpAuthModal } from './StepUpAuthModal';
import { useStepUpTokenStore } from '@/lib/stepUpToken';

vi.mock('@/lib/api', () => ({
  default: { post: vi.fn() },
}));
import apiClient from '@/lib/api';
const mockedApi = apiClient as unknown as { post: ReturnType<typeof vi.fn> };

vi.mock('@/lib/auth', () => ({
  authApi: { initiateOidc: vi.fn(), beginOidcReauth: vi.fn() },
}));
import { authApi } from '@/lib/auth';
const mockedAuthApi = authApi as unknown as {
  initiateOidc: ReturnType<typeof vi.fn>;
  beginOidcReauth: ReturnType<typeof vi.fn>;
};

const mockAuthState: {
  user: { authProvider: 'local' | 'oidc'; hasPassword: boolean } | null;
} = { user: { authProvider: 'local', hasPassword: true } };
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (s: typeof mockAuthState) => unknown) =>
    selector(mockAuthState),
}));

const mockPrefsState: { preferences: { twoFactorEnabled: boolean } | null } = {
  preferences: { twoFactorEnabled: false },
};
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: typeof mockPrefsState) => unknown) =>
    selector(mockPrefsState),
}));

async function renderModal(props: Partial<Parameters<typeof StepUpAuthModal>[0]> = {}) {
  let result: ReturnType<typeof render> | undefined;
  const defaultProps: Parameters<typeof StepUpAuthModal>[0] = {
    isOpen: true,
    purpose: 'emergency-access',
    authProvider: mockAuthState.user?.authProvider ?? 'local',
    hasPassword: mockAuthState.user?.hasPassword ?? true,
    reason: 'Re-verify',
    onClose: vi.fn(),
    onVerified: vi.fn(),
  };
  await act(async () => {
    result = render(<StepUpAuthModal {...defaultProps} {...props} />);
  });
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  useStepUpTokenStore.getState().clearAll();
  mockAuthState.user = { authProvider: 'local', hasPassword: true };
  mockPrefsState.preferences = { twoFactorEnabled: false };
});

describe('StepUpAuthModal — TOTP mode (2FA enabled)', () => {
  beforeEach(() => {
    mockPrefsState.preferences = { twoFactorEnabled: true };
  });

  it('is named by its title and gives the reason in a tooltip', async () => {
    await renderModal();
    const dialog = screen.getByRole('dialog', { name: "Confirm it's you" });
    expect(dialog).toHaveAccessibleDescription('Re-verify');
    expect(dialog.querySelector('.border-t, .border-b')).toBeNull();
  });

  it('renders the 6-digit input and not a password field', async () => {
    await renderModal();
    expect(screen.getByLabelText(/Authenticator code/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password$/i)).not.toBeInTheDocument();
  });

  it('strips non-digit characters as the user types', async () => {
    await renderModal();
    const input = screen.getByLabelText(/Authenticator code/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '12a3b4c' } });
    });
    expect(input.value).toBe('1234');
  });

  it('submits the totpCode and stores the token on success', async () => {
    const onVerified = vi.fn();
    const onClose = vi.fn();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockedApi.post.mockResolvedValue({
      data: { stepUpToken: 'tok-totp', expiresAt },
    });
    await renderModal({ onClose, onVerified });
    const input = screen.getByLabelText(/Authenticator code/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '123456' } });
    });
    const form = input.closest('form');
    await act(async () => {
      fireEvent.submit(form!);
    });
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/step-up', {
      purpose: 'emergency-access',
      totpCode: '123456',
    });
    expect(
      useStepUpTokenStore.getState().getValid('emergency-access'),
    ).toBe('tok-totp');
    expect(onVerified).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error message and does NOT store a token on failure', async () => {
    mockedApi.post.mockRejectedValue({
      response: { data: { message: 'Invalid authenticator code' } },
    });
    await renderModal();
    const input = screen.getByLabelText(/Authenticator code/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '999999' } });
    });
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });
    await waitFor(() =>
      expect(screen.getByText(/Invalid authenticator code/)).toBeInTheDocument(),
    );
    expect(useStepUpTokenStore.getState().getValid('emergency-access')).toBeNull();
  });
});

describe('StepUpAuthModal — password mode (local, no 2FA)', () => {
  it('renders the password input and not the TOTP input', async () => {
    await renderModal();
    expect(screen.getByLabelText(/^Password$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Authenticator code/i)).not.toBeInTheDocument();
  });

  it('submits the password and stores the token on success', async () => {
    const onVerified = vi.fn();
    const onClose = vi.fn();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockedApi.post.mockResolvedValue({
      data: { stepUpToken: 'tok-pwd', expiresAt },
    });
    await renderModal({ onClose, onVerified });
    const input = screen.getByLabelText(/^Password$/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'hunter2' } });
    });
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/step-up', {
      purpose: 'emergency-access',
      password: 'hunter2',
    });
    expect(useStepUpTokenStore.getState().getValid('emergency-access')).toBe(
      'tok-pwd',
    );
    expect(onVerified).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Cancel closes the modal without calling the API', async () => {
    const onClose = vi.fn();
    await renderModal({ onClose });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockedApi.post).not.toHaveBeenCalled();
  });
});

describe('StepUpAuthModal — OIDC user without 2FA', () => {
  beforeEach(() => {
    mockAuthState.user = { authProvider: 'oidc', hasPassword: false };
    mockPrefsState.preferences = { twoFactorEnabled: false };
    sessionStorage.clear();
  });

  it('renders the redirect notice with Continue / Cancel buttons', async () => {
    await renderModal();
    expect(
      screen.getByText(/Sign in again with your identity provider/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Continue to identity provider/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    // No factor inputs.
    expect(screen.queryByLabelText(/^Password$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Authenticator code/i)).not.toBeInTheDocument();
  });

  it('Cancel invokes onClose and does not redirect', async () => {
    const onClose = vi.fn();
    await renderModal({ onClose });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockedAuthApi.beginOidcReauth).not.toHaveBeenCalled();
  });

  it('Continue stashes the resume payload + returnTo and redirects to the IdP', async () => {
    await renderModal({
      oidcReturnTo: '/settings/emergency-access',
      oidcResumePayload: { mode: 'edit' },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Continue to identity provider/i }),
      );
    });
    // The re-auth route, not ordinary login: it names the purpose and its
    // callback mints the proof the step-up endpoint verifies (P2-005).
    expect(mockedAuthApi.beginOidcReauth).toHaveBeenCalledWith('emergency-access');
    const pending = JSON.parse(
      sessionStorage.getItem('stepUpOidcPending') ?? 'null',
    );
    expect(pending).toEqual({
      purpose: 'emergency-access',
      payload: { mode: 'edit' },
    });
    expect(sessionStorage.getItem('postLoginReturnTo')).toBe(
      '/settings/emergency-access',
    );
  });
});

describe('StepUpAuthModal — local user without password (unavailable)', () => {
  beforeEach(() => {
    mockAuthState.user = { authProvider: 'local', hasPassword: false };
    mockPrefsState.preferences = { twoFactorEnabled: false };
  });

  it('renders the "finish setup" notice with a Close button', async () => {
    await renderModal();
    expect(
      screen.getByText(/Finish setting up your account password/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument();
  });

  it('Close invokes onClose', async () => {
    const onClose = vi.fn();
    await renderModal({ onClose });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Close/i }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('StepUpAuthModal — closed state', () => {
  it('renders nothing when isOpen is false', async () => {
    await renderModal({ isOpen: false });
    expect(screen.queryByText(/Confirm it/i)).not.toBeInTheDocument();
  });
});
