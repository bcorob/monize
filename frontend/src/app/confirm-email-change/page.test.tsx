import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import ConfirmEmailChangePage from './page';

const mockConfirmEmailChange = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/confirm-email-change',
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    confirmEmailChange: (...args: any[]) => mockConfirmEmailChange(...args),
  },
}));

async function renderPage() {
  await act(async () => {
    render(<ConfirmEmailChangePage />);
  });
}

describe('ConfirmEmailChangePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams('token=change-token');
    mockConfirmEmailChange.mockResolvedValue({ message: 'ok' });
  });

  it('spends the token once on mount and tells the reader to sign in again', async () => {
    await renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/your email address has been changed/i),
      ).toBeInTheDocument();
    });
    expect(mockConfirmEmailChange).toHaveBeenCalledTimes(1);
    expect(mockConfirmEmailChange).toHaveBeenCalledWith('change-token');
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('shows the error when the link is invalid or expired', async () => {
    mockConfirmEmailChange.mockRejectedValueOnce(new Error('expired'));

    await renderPage();

    await waitFor(() => {
      expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    });
  });

  it('does not call the API when no token is present', async () => {
    mockSearchParams = new URLSearchParams();

    await renderPage();

    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(mockConfirmEmailChange).not.toHaveBeenCalled();
  });
});
