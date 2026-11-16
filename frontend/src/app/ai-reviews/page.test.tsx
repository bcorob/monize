import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import AiReviewsPage from './page';
import AiReviewsLayout from './layout';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/ai-review-api', () => ({
  aiReviewApi: { list: vi.fn().mockResolvedValue([]), dismiss: vi.fn(), approveBatch: vi.fn() },
}));

const replace = vi.hoisted(() => vi.fn());
let actingAsUserId: string | null = null;

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/ai-reviews',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ actingAsUserId }),
}));

describe('AiReviewsPage', () => {
  it('renders the inbox under its heading', async () => {
    await act(async () => {
      render(<AiReviewsPage />);
    });
    expect(screen.getByRole('heading', { level: 1, name: 'AI review inbox' })).toBeInTheDocument();
    expect(screen.getByText('No review requests')).toBeInTheDocument();
  });
});

describe('AiReviewsLayout', () => {
  beforeEach(() => {
    replace.mockClear();
    actingAsUserId = null;
  });

  it('renders its children for the owner', () => {
    render(<AiReviewsLayout><p>inbox</p></AiReviewsLayout>);
    expect(screen.getByText('inbox')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends a delegate to the dashboard and renders nothing', () => {
    actingAsUserId = 'owner-1';
    render(<AiReviewsLayout><p>inbox</p></AiReviewsLayout>);
    expect(screen.queryByText('inbox')).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });
});
