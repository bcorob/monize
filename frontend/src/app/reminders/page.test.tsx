import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import toast from 'react-hot-toast';
import RemindersPage from './page';
import { notificationRemindersApi, type NotificationReminder } from '@/lib/notification-reminders';
const identity = vi.hoisted(() => ({ user: { id: 'u1' }, actingAsUserId: null as string | null }));
vi.mock('@/store/authStore', () => ({
  useAuthStore: (select: (s: typeof identity) => unknown) => select(identity),
}));
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/notification-reminders', () => ({
  notificationRemindersApi: { list: vi.fn(), stop: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const row: NotificationReminder = {
  id: 'r1',
  sourceNotificationId: 'n1',
  type: 'BILL_DUE',
  severity: 'warning',
  title: 'Legacy title',
  message: 'Legacy message',
  target: '/bills',
  repeatMode: 'repeat',
  intervalMinutes: 60,
  nextFireAt: '2026-09-10T12:00:00Z',
  lastFiredAt: null,
  fireCount: 0,
  createdAt: '2026-09-01T12:00:00Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  identity.user = { id: 'u1' };
  identity.actingAsUserId = null;
  vi.mocked(notificationRemindersApi.list).mockResolvedValue([row]);
  vi.mocked(notificationRemindersApi.stop).mockResolvedValue({ stopped: true });
});
describe('active reminders page', () => {
  it('keeps a pending stop visible and accepts an already stopped response', async () => {
    let finish!: (value: { stopped: boolean }) => void;
    vi.mocked(notificationRemindersApi.stop).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<RemindersPage />);
    expect(await screen.findByText('Legacy title')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open related page' })).toHaveAttribute(
      'href',
      '/bills',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop this reminder' }));
    expect(screen.getByRole('button', { name: 'Stop this reminder' })).toBeDisabled();
    expect(screen.getByText('Legacy title')).toBeInTheDocument();
    await act(async () => finish({ stopped: false }));
    expect(await screen.findByText('No active reminders')).toBeInTheDocument();
    expect(notificationRemindersApi.stop).toHaveBeenCalledWith('r1');
  });
  it('keeps the row and enables retry when stopping fails', async () => {
    vi.mocked(notificationRemindersApi.stop).mockRejectedValue(new Error('offline'));
    render(<RemindersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this reminder' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText('Legacy title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop this reminder' })).toBeEnabled();
  });
  it('shows load failure instead of empty success and supports retry', async () => {
    vi.mocked(notificationRemindersApi.list)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    render(<RemindersPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reminders could not be loaded');
    expect(screen.queryByText('No active reminders')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No active reminders')).toBeInTheDocument();
  });
  it('localizes structured facts and refuses external targets', async () => {
    vi.mocked(notificationRemindersApi.list).mockResolvedValue([
      {
        ...row,
        type: 'BALANCE_BELOW_THRESHOLD',
        target: 'https://hostile.example',
        data: { accountName: 'Savings', balance: 5, threshold: 10, currencyCode: 'PLN' },
      },
    ]);
    render(<RemindersPage />);
    expect(await screen.findByText('Savings is below your threshold')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open related page' })).not.toBeInTheDocument();
  });
  it('does not load a delegate list', () => {
    identity.actingAsUserId = 'owner';
    render(<RemindersPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Switch back to your own account');
    expect(notificationRemindersApi.list).not.toHaveBeenCalled();
  });
  it('discards a stop response after the account changes', async () => {
    let finish!: (value: { stopped: boolean }) => void;
    vi.mocked(notificationRemindersApi.stop).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<RemindersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this reminder' }));
    identity.user = { id: 'u2' };
    vi.mocked(notificationRemindersApi.list).mockResolvedValue([{ ...row, title: 'New account' }]);
    view.rerender(<RemindersPage />);
    expect(await screen.findByText('New account')).toBeInTheDocument();
    await act(async () => finish({ stopped: true }));
    expect(screen.getByText('New account')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('discards a previous account request', async () => {
    let oldResult!: (rows: NotificationReminder[]) => void;
    vi.mocked(notificationRemindersApi.list)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          oldResult = resolve;
        }),
      )
      .mockResolvedValueOnce([{ ...row, id: 'r2', title: 'New account' }]);
    const view = render(<RemindersPage />);
    identity.user = { id: 'u2' };
    view.rerender(<RemindersPage />);
    expect(await screen.findByText('New account')).toBeInTheDocument();
    await act(async () => oldResult([row]));
    expect(screen.queryByText('Legacy title')).not.toBeInTheDocument();
  });
});
