import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent } from '@/test/render';
import { AppHeader } from './AppHeader';

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

vi.mock('@/lib/auth', () => ({
  authApi: { logout: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="budget-alert-badge" />,
}));

let mockActingAsUserId: string | null = null;

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      user: { id: 'u-1', email: 'a@example.com', firstName: 'Ann', lastName: 'B', role: 'user' },
      logout: vi.fn(),
      actingAsUserId: mockActingAsUserId,
      delegateCapabilities: null,
      // A delegate holding the AI grant still sees the AI menu.
      delegateSections: { ai: true },
    };
    return selector ? selector(state) : state;
  },
}));

function openAiMenu() {
  fireEvent.click(screen.getAllByText('AI')[0]);
}

describe('AppHeader AI review inbox entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActingAsUserId = null;
  });

  it('lists the inbox in the AI menu for the owner and opens the page', () => {
    const router = useRouter();
    render(<AppHeader />);
    openAiMenu();
    fireEvent.click(screen.getAllByText('AI Review Inbox')[0]);
    expect(router.push).toHaveBeenCalledWith('/ai-reviews');
  });

  it('hides the inbox from a delegate who can still use the AI menu', () => {
    mockActingAsUserId = 'owner-1';
    render(<AppHeader />);
    openAiMenu();
    expect(screen.getAllByText('AI Assistant').length).toBeGreaterThan(0);
    expect(screen.queryByText('AI Review Inbox')).not.toBeInTheDocument();
  });
});
