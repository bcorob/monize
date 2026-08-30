import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import EmergencyAccessPage from './page';
import type { EmergencyAccessView } from '@/types/emergency-access';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

const mockUseDemoMode = vi.fn();
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

const mockActingAs = vi.fn();
vi.mock('@/store/authStore', () => ({
  useAuthStore: (
    selector: (s: { actingAsUserId: string | null }) => unknown,
  ) => selector({ actingAsUserId: mockActingAs() }),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (
    selector: (s: {
      preferences: {
        timezone: string;
        dateFormat: string;
        timeFormat: '24h' | '12h';
      };
    }) => unknown,
  ) =>
    selector({
      preferences: {
        timezone: 'browser',
        dateFormat: 'browser',
        timeFormat: '24h',
      },
    }),
}));

// Stub the step-up modal -- exercised separately in its own test file. The
// stub exposes a synthetic "Verify" button that simulates a successful
// re-auth by stamping a token into the store and calling onVerified.
vi.mock('@/components/auth/StepUpAuthModal', () => ({
  StepUpAuthModal: ({
    isOpen,
    onClose,
    onVerified,
    authProvider,
    hasPassword,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onVerified?: () => void;
    authProvider: 'local' | 'oidc';
    hasPassword: boolean;
  }) =>
    isOpen ? (
      <div
        data-testid="step-up-modal"
        data-auth-provider={authProvider}
        data-has-password={String(hasPassword)}
      >
        <button
          onClick={async () => {
            const { useStepUpTokenStore } = await import('@/lib/stepUpToken');
            useStepUpTokenStore
              .getState()
              .set(
                'emergency-access',
                'mock-token',
                new Date(Date.now() + 5 * 60 * 1000).toISOString(),
              );
            onVerified?.();
            onClose();
          }}
        >
          Mock Verify
        </button>
        <button onClick={onClose}>Mock Close</button>
      </div>
    ) : null,
}));

vi.mock('@/lib/api', () => ({
  default: { post: vi.fn() },
}));
import apiClient from '@/lib/api';
const mockedApi = apiClient as unknown as {
  post: ReturnType<typeof vi.fn>;
};

vi.mock('@/lib/auth', () => ({
  authApi: {
    getSelfProfile: vi.fn().mockResolvedValue({
      id: 'self-1',
      email: 'me@example.com',
      authProvider: 'local',
      hasPassword: true,
      role: 'user',
      isActive: true,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  },
}));

vi.mock('@/lib/emergency-access', () => ({
  emergencyAccessApi: {
    get: vi.fn(),
    getMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateSettings: vi.fn(),
    addContact: vi.fn(),
    updateContact: vi.fn(),
    removeContact: vi.fn(),
    reset: vi.fn(),
    previewClaim: vi.fn(),
    completeClaim: vi.fn(),
  },
}));

import { emergencyAccessApi } from '@/lib/emergency-access';
import { authApi } from '@/lib/auth';
import { useStepUpTokenStore, StepUpRequiredError } from '@/lib/stepUpToken';
const api = emergencyAccessApi as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const mockedAuthApi = authApi as unknown as {
  getSelfProfile: ReturnType<typeof vi.fn>;
};

function makeView(
  overrides: Partial<EmergencyAccessView> = {},
): EmergencyAccessView {
  return {
    emailConfigured: true,
    credentialEncryptionConfigured: true,
    enabled: false,
    grantAfterDays: 14,
    reminderAfterDays: 7,
    messageMetadata: { hasMessage: false, charCount: 0, updatedAt: null },
    lastReminderSentAt: null,
    grantedAt: null,
    lastActivityAt: new Date().toISOString(),
    contacts: [],
    ...overrides,
  };
}

async function renderPage() {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(<EmergencyAccessPage />);
  });
  return result!;
}

describe('EmergencyAccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDemoMode.mockReturnValue(false);
    mockActingAs.mockReturnValue(null);
    useStepUpTokenStore.getState().clearAll();
    sessionStorage.clear();
  });

  it('blocks access for delegate sessions', async () => {
    mockActingAs.mockReturnValue('other-user');
    api.get.mockResolvedValue(makeView());
    await renderPage();
    expect(
      screen.getByText(
        /Emergency access can only be configured by the account owner/,
      ),
    ).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('blocks access in demo mode', async () => {
    mockUseDemoMode.mockReturnValue(true);
    await renderPage();
    expect(
      screen.getByText(/Emergency access is disabled in demo mode/),
    ).toBeInTheDocument();
  });

  it('shows the SMTP-not-configured notice when emailConfigured is false', async () => {
    api.get.mockResolvedValue(makeView({ emailConfigured: false }));
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Email is not configured/)).toBeInTheDocument(),
    );
    expect(
      (screen.getByRole('button', {
        name: /Save settings/i,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  /**
   * The two configuration halves fail independently, and the second fails
   * silently: without ENCRYPTION_KEY a grant cannot store the claim link it
   * would resend, so it delivers nothing, releases itself, and repeats every day
   * -- while this page reported the safeguard as armed because it only knew about
   * SMTP (audit RRV4-003).
   */
  it('shows the encryption-key notice when only that half is missing', async () => {
    // Currently enabled, so turning it off must remain possible on an installation
    // that cannot arm it (audit V4R3-002) -- which is why Save stays live.
    api.get.mockResolvedValue(
      makeView({ enabled: true, credentialEncryptionConfigured: false }),
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Encryption key required/)).toBeInTheDocument(),
    );
    // Not the SMTP notice: naming the wrong missing thing sends the operator to
    // the wrong variable.
    expect(screen.queryByText(/Email is not configured/)).toBeNull();
    expect(
      (screen.getByRole('button', {
        name: /Save settings/i,
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('lets the owner disable an enabled feature even when SMTP is missing', async () => {
    // Audit V4R3-002: a missing dependency stops arming, never disabling. A feature
    // already stored as enabled has to stay switch-off-able, or the owner cannot
    // revoke a safeguard after SMTP was removed.
    api.get.mockResolvedValue(
      makeView({ enabled: true, emailConfigured: false }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Save settings/i }),
      ).toBeInTheDocument(),
    );
    // Save stays usable, so the owner can submit enabled:false.
    expect(
      (screen.getByRole('button', {
        name: /Save settings/i,
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps the settings controls locked when a disabled feature cannot be armed', async () => {
    // Disabled and unarmable: there is nothing to turn off, so arming stays blocked.
    api.get.mockResolvedValue(
      makeView({ enabled: false, emailConfigured: false }),
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Email is not configured/)).toBeInTheDocument(),
    );
    expect(
      (screen.getByRole('button', {
        name: /Save settings/i,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('names both missing dependencies when both are missing', async () => {
    // Gating the encryption notice on `emailConfigured` made diagnosis
    // sequential: the operator was told about SMTP, fixed it, reloaded, and only
    // then learned about the key. The two fail independently, which is the whole
    // reason this page reports them separately at all.
    api.get.mockResolvedValue(
      makeView({ emailConfigured: false, credentialEncryptionConfigured: false }),
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Email is not configured/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Encryption key required/)).toBeInTheDocument();
  });

  it('clamps the enable toggle to off while the feature cannot be armed', async () => {
    // The clamp is the only thing stopping a degraded install submitting
    // `enabled: true`, which the server refuses with a 503. Dropping the ternary
    // leaves every other assertion in this file passing.
    api.get.mockResolvedValue(
      makeView({ enabled: true, credentialEncryptionConfigured: false }),
    );
    api.updateSettings.mockResolvedValue(makeView({ enabled: false }));
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Save settings/i }),
    );

    // Try to turn it back *on*; the control must refuse to move.
    const toggle = screen.getByRole('switch', {
      name: /Enable emergency access/i,
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save settings/i }),
      );
    });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].enabled).toBe(false);
  });

  it('locks the waiting-period fields while the feature cannot be armed', async () => {
    // Only disabling is useful on a degraded install, so a live day field invites
    // a save that can only 503.
    api.get.mockResolvedValue(
      makeView({ enabled: true, credentialEncryptionConfigured: false }),
    );
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Save settings/i }),
    );
    expect(
      (
        screen.getByLabelText(
          /Days of inactivity before access is granted/i,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          /Days of inactivity before reminder emails/i,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it('shows no configuration notice when both halves are ready', async () => {
    api.get.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save settings/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Encryption key required/)).toBeNull();
    expect(screen.queryByText(/Email is not configured/)).toBeNull();
  });

  it('renders metadata for a configured message without the plaintext', async () => {
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: {
          hasMessage: true,
          charCount: 12,
          updatedAt: '2026-05-01T00:00:00Z',
        },
      }),
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Message set/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/12 chars/)).toBeInTheDocument();
    // The plaintext is never on screen until the user verifies.
    expect(screen.queryByText('top-secret')).not.toBeInTheDocument();
  });

  it('renders "No message set" when nothing has been stored yet', async () => {
    api.get.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No message set/)).toBeInTheDocument(),
    );
    // Reveal is disabled when there's no message; Add message is enabled.
    const reveal = screen.getByRole('button', { name: /Reveal message/i });
    expect((reveal as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole('button', { name: /Add message/i }),
    ).toBeInTheDocument();
  });

  it('finalizes step-up on mount when returning from an OIDC roundtrip', async () => {
    sessionStorage.setItem(
      'stepUpOidcPending',
      JSON.stringify({
        purpose: 'emergency-access',
        payload: { mode: 'view' },
      }),
    );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 7, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'returned' });
    // The artifact the OIDC callback stashed. The endpoint verifies and spends
    // it; the client used to just assert `oidcConfirmed: true` (P2-005).
    sessionStorage.setItem('oidcReauthArtifact', 'signed.artifact.value');
    mockedApi.post.mockResolvedValue({
      data: {
        stepUpToken: 'oidc-confirmed-token',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
    await renderPage();
    // Drain the microtask queue so the post-then-fetch chain settles.
    await act(async () => {});
    await act(async () => {});
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    expect(mockedApi.post).toHaveBeenCalledWith('/auth/step-up', {
      purpose: 'emergency-access',
      oidcReauthToken: 'signed.artifact.value',
    });
    // Spent on read: a second attempt has to earn a fresh one.
    expect(sessionStorage.getItem('oidcReauthArtifact')).toBeNull();
    expect(
      useStepUpTokenStore.getState().getValid('emergency-access'),
    ).toBe('oidc-confirmed-token');
    // Sentinel was consumed.
    expect(sessionStorage.getItem('stepUpOidcPending')).toBeNull();
    // And the requested mode resumed.
    await waitFor(() =>
      expect(screen.getByText('returned')).toBeInTheDocument(),
    );
  });

  it('skips the OIDC finalize when the sentinel targets a different purpose', async () => {
    sessionStorage.setItem(
      'stepUpOidcPending',
      JSON.stringify({ purpose: 'something-else' }),
    );
    api.get.mockResolvedValue(makeView());
    await renderPage();
    await act(async () => {});
    expect(mockedApi.post).not.toHaveBeenCalled();
    // Sentinel remains for whoever it was intended for.
    expect(sessionStorage.getItem('stepUpOidcPending')).not.toBeNull();
  });

  it('toasts and does not store a token when the OIDC finalize call fails', async () => {
    sessionStorage.setItem(
      'stepUpOidcPending',
      JSON.stringify({ purpose: 'emergency-access' }),
    );
    api.get.mockResolvedValue(makeView());
    mockedApi.post.mockRejectedValue(new Error('server boom'));
    await renderPage();
    await act(async () => {});
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    expect(
      useStepUpTokenStore.getState().getValid('emergency-access'),
    ).toBeNull();
  });

  it('passes authProvider=oidc to the modal for OIDC users (regression for #unavailable-fallthrough)', async () => {
    // Regression: /auth/profile (used to hydrate the auth store) omits
    // authProvider, so reading it from the store gave undefined and the
    // modal fell through to its "unavailable" branch. The page must
    // explicitly fetch /auth/me-self and pass the value down.
    mockedAuthApi.getSelfProfile.mockResolvedValueOnce({
      id: 'self-1',
      email: 'oidc@example.com',
      authProvider: 'oidc',
      hasPassword: false,
      role: 'user',
      isActive: true,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    await renderPage();
    await waitFor(() =>
      expect(mockedAuthApi.getSelfProfile).toHaveBeenCalled(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    const modal = await screen.findByTestId('step-up-modal');
    expect(modal.getAttribute('data-auth-provider')).toBe('oidc');
    expect(modal.getAttribute('data-has-password')).toBe('false');
  });

  it('keeps the modal closed until the self profile has loaded', async () => {
    let resolveProfile!: (u: unknown) => void;
    mockedAuthApi.getSelfProfile.mockReturnValueOnce(
      new Promise((res) => {
        resolveProfile = res;
      }),
    );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Reveal message/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    // Without the self profile yet, the modal must not pop with stale data.
    expect(screen.queryByTestId('step-up-modal')).not.toBeInTheDocument();

    await act(async () => {
      resolveProfile({
        id: 'self-1',
        email: 'me@example.com',
        authProvider: 'local',
        hasPassword: true,
        role: 'user',
        isActive: true,
        mustChangePassword: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('step-up-modal')).toBeInTheDocument(),
    );
  });

  it('clicking Reveal opens the step-up modal when no token is present', async () => {
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Reveal message/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    expect(screen.getByTestId('step-up-modal')).toBeInTheDocument();
    expect(api.getMessage).not.toHaveBeenCalled();
  });

  it('after verifying via the modal, the message is fetched and shown', async () => {
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 10, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'top-secret' });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Reveal message/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Mock Verify/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expect(screen.getByText('top-secret')).toBeInTheDocument();
    // After unlock the countdown card should appear.
    expect(screen.getByText(/Unlocked for/)).toBeInTheDocument();
  });

  it('skips the modal when a valid token is already cached', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 5, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'cached msg' });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Reveal message/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expect(screen.queryByTestId('step-up-modal')).not.toBeInTheDocument();
    expect(screen.getByText('cached msg')).toBeInTheDocument();
  });

  it('Edit message with a cached token skips the modal and opens the editor', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'old' });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Edit message/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Edit message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Notes, instructions/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('step-up-modal')).not.toBeInTheDocument();
  });

  it('Cancel inside the editor returns to view mode without clearing the token', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'msg' });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Edit message/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Edit message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      screen.getByPlaceholderText(/Notes, instructions/i),
    );
    // Cancel inside the edit form
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    await waitFor(() => expect(screen.getByText('msg')).toBeInTheDocument());
    // Token is still active.
    expect(
      useStepUpTokenStore.getState().getValid('emergency-access'),
    ).toBe('cached');
  });

  it('updateMessage failure (non step-up) leaves the editor open and toasts', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'old' });
    api.updateMessage.mockRejectedValue(new Error('database boom'));
    await renderPage();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Edit message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      screen.getByPlaceholderText(/Notes, instructions/i),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.updateMessage).toHaveBeenCalled());
    // Editor stays open because the save failed.
    expect(
      screen.getByPlaceholderText(/Notes, instructions/i),
    ).toBeInTheDocument();
  });

  it('Lock now clears the token and hides the plaintext', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 5, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'sensitive' });
    await renderPage();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(screen.getByText('sensitive')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Lock now/i }));
    });
    expect(screen.queryByText('sensitive')).not.toBeInTheDocument();
    expect(
      useStepUpTokenStore.getState().getValid('emergency-access'),
    ).toBeNull();
  });

  it('STEP_UP_REQUIRED from getMessage opens the modal', async () => {
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 5, updatedAt: null },
      }),
    );
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'expired-on-server',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.getMessage.mockRejectedValue(
      new StepUpRequiredError('emergency-access', 'expired'),
    );
    await renderPage();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getByTestId('step-up-modal')).toBeInTheDocument(),
    );
  });

  it('shows a toast and stays on the metadata card when getMessage fails for another reason', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 5, updatedAt: null },
      }),
    );
    api.getMessage.mockRejectedValue(new Error('network'));
    await renderPage();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {});
    // The card stayed in its hidden mode (no plaintext, no countdown).
    expect(screen.queryByText(/Unlocked for/)).not.toBeInTheDocument();
  });

  it('opens the editor after verifying and saves a new message', async () => {
    api.get.mockResolvedValue(makeView());
    api.getMessage.mockResolvedValue({ message: '' });
    api.updateMessage.mockResolvedValue({
      hasMessage: true,
      charCount: 5,
      updatedAt: null,
    });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Add message/i }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add message/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Mock Verify/i }));
    });
    await act(async () => {});
    await waitFor(() =>
      screen.getByPlaceholderText(/Notes, instructions/i),
    );
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Notes, instructions/i), {
        target: { value: 'hello' },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.updateMessage).toHaveBeenCalledWith('hello'));
  });

  it('updateMessage rejection with STEP_UP_EXPIRED reopens the modal', async () => {
    useStepUpTokenStore
      .getState()
      .set(
        'emergency-access',
        'cached',
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
    api.get.mockResolvedValue(
      makeView({
        messageMetadata: { hasMessage: true, charCount: 4, updatedAt: null },
      }),
    );
    api.getMessage.mockResolvedValue({ message: 'old' });
    api.updateMessage.mockRejectedValue(
      new StepUpRequiredError('emergency-access', 'expired'),
    );
    await renderPage();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Reveal message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      screen.getByRole('button', { name: /^Edit$/i }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    });
    await waitFor(() =>
      screen.getByPlaceholderText(/Notes, instructions/i),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save message/i }),
      );
    });
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getByTestId('step-up-modal')).toBeInTheDocument(),
    );
  });

  it('saves the (non-message) settings via the API', async () => {
    const initial = makeView();
    const updated = makeView({ enabled: true });
    api.get.mockResolvedValue(initial);
    api.updateSettings.mockResolvedValue(updated);
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Save settings/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save settings/i }),
      );
    });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const payload = api.updateSettings.mock.calls[0][0];
    expect(payload).toEqual({
      enabled: false,
      grantAfterDays: 14,
      reminderAfterDays: 7,
    });
    expect(payload).not.toHaveProperty('message');
  });

  it('toggles the enable switch via setValue', async () => {
    api.get.mockResolvedValue(makeView());
    api.updateSettings.mockResolvedValue(makeView({ enabled: true }));
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Save settings/i }),
    );
    const toggle = screen.getByRole('switch', {
      name: /Enable emergency access/i,
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save settings/i }),
      );
    });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].enabled).toBe(true);
  });

  it('renders a warning when access has already been granted', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
  });

  it('renders an unable-to-load message when the initial fetch fails', async () => {
    api.get.mockRejectedValue(new Error('network down'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/Unable to load emergency access/),
      ).toBeInTheDocument(),
    );
  });

  it('adds a contact via the API', async () => {
    api.get.mockResolvedValue(makeView());
    api.addContact.mockResolvedValue({
      id: 'new',
      firstName: 'Carol',
      email: 'carol@example.com',
      createdAt: new Date().toISOString(),
    });
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Add contact/i }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });

    const firstName = screen.getByLabelText(/First name/i);
    const email = screen.getByLabelText(/^Email$/i);
    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carol' } });
      fireEvent.input(email, { target: { value: 'carol@example.com' } });
    });
    const form = firstName.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });
    await act(async () => {});

    await waitFor(() => expect(api.addContact).toHaveBeenCalled());
    expect(api.addContact.mock.calls[0][0]).toEqual({
      firstName: 'Carol',
      email: 'carol@example.com',
    });
  });

  it('opens the contact form pre-populated when editing an existing contact', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.updateContact.mockResolvedValue({
      id: 'c1',
      firstName: 'Carrie',
      email: 'carrie@example.com',
      createdAt: new Date().toISOString(),
    });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Carol')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    });

    const firstName = screen.getByLabelText(/First name/i);
    expect((firstName as HTMLInputElement).value).toBe('Carol');

    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carrie' } });
      fireEvent.input(screen.getByLabelText(/^Email$/i), {
        target: { value: 'carrie@example.com' },
      });
    });
    const form = firstName.closest('form');
    await act(async () => {
      fireEvent.submit(form!);
    });
    await act(async () => {});

    await waitFor(() => expect(api.updateContact).toHaveBeenCalled());
    expect(api.updateContact.mock.calls[0][0]).toBe('c1');
    expect(api.updateContact.mock.calls[0][1]).toEqual({
      firstName: 'Carrie',
      email: 'carrie@example.com',
    });
  });

  it('removes a contact via the confirm dialog', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.removeContact.mockResolvedValue(undefined);
    await renderPage();
    await waitFor(() => expect(screen.getByText('Carol')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() =>
      expect(screen.getByText('Remove contact')).toBeInTheDocument(),
    );
    const removeButtons = screen.getAllByRole('button', {
      name: /^Remove$/i,
    });
    await act(async () => {
      fireEvent.click(removeButtons[removeButtons.length - 1]);
    });
    await waitFor(() => expect(api.removeContact).toHaveBeenCalledWith('c1'));
  });

  it('shows a toast when settings save fails', async () => {
    api.get.mockResolvedValue(makeView());
    api.updateSettings.mockRejectedValue(new Error('validation failed'));
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Save settings/i }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Save settings/i }),
      );
    });
    await act(async () => {});
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
  });

  it('shows a toast and keeps the contact when removeContact() fails', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    api.removeContact.mockRejectedValue(new Error('still has pending grant'));
    await renderPage();
    await waitFor(() => screen.getByText('Carol'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() => screen.getByText('Remove contact'));
    const removeButtons = screen.getAllByRole('button', {
      name: /^Remove$/i,
    });
    await act(async () => {
      fireEvent.click(removeButtons[removeButtons.length - 1]);
    });
    await act(async () => {});
    await waitFor(() => expect(api.removeContact).toHaveBeenCalled());
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('shows a toast when adding a contact fails', async () => {
    api.get.mockResolvedValue(makeView());
    api.addContact.mockRejectedValue(new Error('duplicate'));
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Add contact/i }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });
    const firstName = screen.getByLabelText(/First name/i);
    await act(async () => {
      fireEvent.input(firstName, { target: { value: 'Carol' } });
      fireEvent.input(screen.getByLabelText(/^Email$/i), {
        target: { value: 'carol@example.com' },
      });
    });
    const form = firstName.closest('form');
    await act(async () => {
      fireEvent.submit(form!);
    });
    await act(async () => {});
    await waitFor(() => expect(api.addContact).toHaveBeenCalled());
    // Modal stays open because the API rejected.
    expect(screen.getByText('Add emergency contact')).toBeInTheDocument();
  });

  it('cancels the remove-contact confirm dialog without calling the API', async () => {
    api.get.mockResolvedValue(
      makeView({
        contacts: [
          {
            id: 'c1',
            firstName: 'Carol',
            email: 'carol@example.com',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await renderPage();
    await waitFor(() => screen.getByText('Carol'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    });
    await waitFor(() => screen.getByText('Remove contact'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    await waitFor(() =>
      expect(screen.queryByText('Remove contact')).not.toBeInTheDocument(),
    );
    expect(api.removeContact).not.toHaveBeenCalled();
  });

  it('cancels the clear-granted confirm dialog without calling the API', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Cancel$/i }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    });
    expect(api.reset).not.toHaveBeenCalled();
  });

  it('clears the granted state via the confirm dialog', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    api.reset.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear' }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    await waitFor(() => expect(api.reset).toHaveBeenCalled());
  });

  it('shows a toast and stays on the page when reset() fails', async () => {
    api.get.mockResolvedValue(
      makeView({ grantedAt: new Date().toISOString() }),
    );
    api.reset.mockRejectedValue(new Error('server down'));
    await renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Emergency access already granted'),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Clear granted state/i }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear' }),
      ).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    await act(async () => {});
    await waitFor(() => expect(api.reset).toHaveBeenCalled());
    expect(
      screen.getByText('Emergency access already granted'),
    ).toBeInTheDocument();
  });

  it('closes the contact modal via Cancel', async () => {
    api.get.mockResolvedValue(makeView());
    await renderPage();
    await waitFor(() =>
      screen.getByRole('button', { name: /Add contact/i }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add contact/i }));
    });
    await waitFor(() => screen.getByText('Add emergency contact'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    });
    await waitFor(() =>
      expect(
        screen.queryByText('Add emergency contact'),
      ).not.toBeInTheDocument(),
    );
  });
});
