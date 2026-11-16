import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import {
  WeakJwtSecretBanner,
  WEAK_JWT_SECRET_BANNER_DISMISSED_KEY,
} from './WeakJwtSecretBanner';
import { useAuthStore } from '@/store/authStore';
import { adminApi } from '@/lib/admin';
import type { User } from '@/types/auth';

vi.mock('@/lib/admin', () => ({
  adminApi: { getDeploymentStatus: vi.fn() },
}));

const adminUser: User = {
  id: 'admin-1',
  email: 'admin@example.com',
  authProvider: 'local',
  hasPassword: true,
  role: 'admin',
  isActive: true,
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const regularUser: User = { ...adminUser, id: 'user-1', role: 'user' };

async function renderBanner() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<WeakJwtSecretBanner />);
  });
  return result!;
}

describe('WeakJwtSecretBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('warns an administrator about a weak JWT_SECRET, with the fix and its cost', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(adminApi.getDeploymentStatus).mockResolvedValue({ jwtSecretWeakness: 'placeholder' });

    await renderBanner();

    expect(screen.getByRole('alert')).toHaveTextContent('JWT_SECRET is weak.');
    expect(screen.getByText('openssl rand -base64 32')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/stops authenticator codes from working/);
    expect(screen.getByRole('alert')).toHaveTextContent(/backup code/);
    expect(screen.getByRole('link', { name: 'User Management' })).toHaveAttribute('href', '/admin/users');
  });

  it('renders nothing for a regular user, and never asks the server', async () => {
    useAuthStore.setState({ user: regularUser, isAuthenticated: true });
    vi.mocked(adminApi.getDeploymentStatus).mockResolvedValue({ jwtSecretWeakness: 'placeholder' });

    const { container } = await renderBanner();

    expect(container.firstChild).toBeNull();
    expect(adminApi.getDeploymentStatus).not.toHaveBeenCalled();
  });

  it('renders nothing when the secret is sound', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(adminApi.getDeploymentStatus).mockResolvedValue({ jwtSecretWeakness: null });

    const { container } = await renderBanner();

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the status request fails', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(adminApi.getDeploymentStatus).mockRejectedValue(new Error('500'));

    const { container } = await renderBanner();

    expect(container.firstChild).toBeNull();
  });

  it('can be dismissed, for the rest of the browser session', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(adminApi.getDeploymentStatus).mockResolvedValue({ jwtSecretWeakness: 'predictable' });

    const { unmount } = await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss JWT_SECRET warning' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(WEAK_JWT_SECRET_BANNER_DISMISSED_KEY)).toBe('1');

    // A later page in the same session stays quiet.
    unmount();
    await renderBanner();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
