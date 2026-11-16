import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import EmailReceiptsSettingsPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace, push: vi.fn() }),
}));

describe('EmailReceiptsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends an old link to the Mailbox tab of the hub', async () => {
    await act(async () => {
      render(<EmailReceiptsSettingsPage />);
    });
    expect(replace).toHaveBeenCalledWith('/email-receipts?tab=mailbox');
  });

  it('offers the same place as a link while the redirect happens', async () => {
    await act(async () => {
      render(<EmailReceiptsSettingsPage />);
    });
    expect(screen.getByRole('link', { name: 'Go to the mailbox settings' })).toHaveAttribute(
      'href',
      '/email-receipts?tab=mailbox',
    );
  });
});
