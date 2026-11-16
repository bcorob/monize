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

const manage = { create: true, edit: true, delete: true };
let mockActingAsUserId: string | null = null;
let mockDelegateCapabilities: unknown = null;

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      user: { id: 'u-1', email: 'a@example.com', firstName: 'Ann', lastName: 'B', role: 'user' },
      logout: vi.fn(),
      actingAsUserId: mockActingAsUserId,
      delegateCapabilities: mockDelegateCapabilities,
      delegateSections: null,
    };
    return selector ? selector(state) : state;
  },
}));

function openToolsMenu() {
  fireEvent.click(screen.getAllByText('Tools')[0]);
}

describe('AppHeader Rules entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActingAsUserId = null;
    mockDelegateCapabilities = null;
  });

  it('lists Rules in the Tools menu for the owner and opens the page', () => {
    const router = useRouter();
    render(<AppHeader />);
    openToolsMenu();
    fireEvent.click(screen.getAllByText('Rules')[0]);
    expect(router.push).toHaveBeenCalledWith('/rules');
  });

  it('anchors the tour on the Rules entry, only while the Tools menu is open', () => {
    const { container } = render(<AppHeader />);
    expect(container.querySelector('[data-tour-id="nav-rules"]')).toBeNull();
    openToolsMenu();
    const anchored = container.querySelectorAll('[data-tour-id="nav-rules"]');
    expect(anchored).toHaveLength(1);
    expect(anchored[0]).toHaveTextContent('Rules');
    expect(anchored[0].closest('[data-tour-id="nav-tools-menu"]')).not.toBeNull();
  });

  it('does not show Rules to a delegate, even one who manages every tool section', () => {
    mockActingAsUserId = 'owner-1';
    mockDelegateCapabilities = { payees: manage, categories: manage, tags: manage };
    render(<AppHeader />);
    openToolsMenu();
    // The granted sections are there, so the menu itself is open and filtered.
    expect(screen.getAllByText('Tags').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rules')).not.toBeInTheDocument();
  });
});
