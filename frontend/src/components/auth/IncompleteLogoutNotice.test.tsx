import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { IncompleteLogoutNotice } from './IncompleteLogoutNotice';

const mockApiLogout = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/auth', () => ({
  authApi: {
    logout: (...args: any[]) => mockApiLogout(...args),
  },
}));

describe('IncompleteLogoutNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiLogout.mockResolvedValue(undefined);
    window.sessionStorage.clear();
  });

  it('renders nothing when the last logout was confirmed', () => {
    const { container } = render(<IncompleteLogoutNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('warns that only this browser was signed out', () => {
    window.sessionStorage.setItem('monize:logout-incomplete', '1');
    render(<IncompleteLogoutNotice />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/only this browser was signed out/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /retry sign-out/i }),
    ).toBeInTheDocument();
  });

  it('clears the warning when the retry reaches the server', async () => {
    window.sessionStorage.setItem('monize:logout-incomplete', '1');
    render(<IncompleteLogoutNotice />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry sign-out/i }));
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem('monize:logout-incomplete')).toBeNull();
  });

  // The session is still live, so the warning has to survive a failed retry
  // rather than disappearing and leaving the ordinary signed-out screen.
  it('keeps warning when the retry also fails', async () => {
    window.sessionStorage.setItem('monize:logout-incomplete', '1');
    mockApiLogout.mockRejectedValue(new Error('still offline'));
    render(<IncompleteLogoutNotice />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry sign-out/i }));
    });
    await act(async () => {});

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('monize:logout-incomplete')).toBe('1');
  });
});
