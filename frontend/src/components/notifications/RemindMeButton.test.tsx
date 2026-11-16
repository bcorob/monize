import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import type { Notification } from '@/types/notification';
import { RemindMeButton } from './RemindMeButton';

const { createMock, stopMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock('@/lib/notification-reminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-reminders')>()),
  notificationRemindersApi: {
    create: createMock,
    stop: stopMock,
    list: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notification-1',
  userId: 'user-1',
  budgetId: null,
  budgetCategoryId: null,
  type: 'BILL_DUE',
  severity: 'warning',
  title: 'Rent due',
  message: 'Rent is due',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('RemindMeButton', () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: 'rem-1' });
    stopMock.mockReset().mockResolvedValue({ stopped: true });
  });

  it('creates a reminder with the chosen mode and interval', async () => {
    render(<RemindMeButton notification={makeNotification()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-me-notification-1'));
    });

    // Choose "just once" and a 15-minute interval, then confirm.
    fireEvent.click(screen.getByTestId('reminder-mode-once'));
    fireEvent.click(screen.getByTestId('reminder-interval-15'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('reminder-confirm'));
    });

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        sourceNotificationId: 'notification-1',
        repeatMode: 'once',
        intervalMinutes: 15,
      }),
    );
  });

  it('defaults to a repeating reminder', async () => {
    render(<RemindMeButton notification={makeNotification()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-me-notification-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('reminder-confirm'));
    });
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ repeatMode: 'repeat', intervalMinutes: 60 }),
      ),
    );
  });

  it('offers Stop (not Remind) on a row that is itself a reminder re-delivery', async () => {
    render(
      <RemindMeButton
        notification={makeNotification({ data: { reminderId: 'rem-9' } })}
      />,
    );
    expect(screen.queryByTestId('remind-me-notification-1')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('stop-reminder-notification-1'));
    });
    await waitFor(() => expect(stopMock).toHaveBeenCalledWith('rem-9'));
  });
});
