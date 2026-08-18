import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { ReconciliationReminderBadge } from './ReconciliationReminderBadge';
import { notifyReconciliationChanged } from '@/lib/reconciliationSignal';

const mockGetStale = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getStaleUnreconciled: (...args: unknown[]) => mockGetStale(...args),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => String(d) }),
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

const summary = {
  staleAfterDays: 45,
  overdueBefore: '2026-07-04',
  totalCount: 4,
  accounts: [
    {
      accountId: 'acc-1',
      accountName: 'Checking',
      currencyCode: 'USD',
      count: 3,
      oldestDate: '2026-01-15',
      lastReconciledDate: '2026-06-30',
      missedCount: 2,
      overdueCount: 1,
    },
    {
      accountId: 'acc-2',
      accountName: 'Visa',
      currencyCode: 'USD',
      count: 1,
      oldestDate: '2026-05-02',
      lastReconciledDate: '2026-05-31',
      missedCount: 1,
      overdueCount: 0,
    },
  ],
};

async function renderBadge() {
  await act(async () => {
    render(<ReconciliationReminderBadge />);
  });
}

describe('ReconciliationReminderBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStale.mockResolvedValue(summary);
  });

  it('shows the outstanding count', async () => {
    await renderBadge();
    expect(screen.getByTestId('reconcile-reminder-count')).toHaveTextContent('4');
  });

  it('caps the badge digits rather than widening the header', async () => {
    mockGetStale.mockResolvedValue({ ...summary, totalCount: 42 });
    await renderBadge();
    expect(screen.getByTestId('reconcile-reminder-count')).toHaveTextContent('9+');
  });

  it('renders nothing for a user with nothing outstanding', async () => {
    mockGetStale.mockResolvedValue({ ...summary, totalCount: 0, accounts: [] });
    await renderBadge();
    expect(screen.queryByTestId('reconcile-reminder-button')).not.toBeInTheDocument();
  });

  it('renders nothing when the lookup fails', async () => {
    // A failed request is not "nothing is overdue". Showing a zero-state here
    // would report an outage as a clean bill of health.
    mockGetStale.mockRejectedValue(new Error('boom'));
    await renderBadge();
    await act(async () => {});
    expect(screen.queryByTestId('reconcile-reminder-button')).not.toBeInTheDocument();
  });

  it('renders nothing when the API surface throws synchronously', async () => {
    // The badge is in the app header, so a throw here would unmount the header
    // rather than merely hide a reminder.
    mockGetStale.mockImplementation(() => {
      throw new TypeError('transactionsApi.getStaleUnreconciled is not a function');
    });
    await renderBadge();
    await act(async () => {});
    expect(screen.queryByTestId('reconcile-reminder-button')).not.toBeInTheDocument();
  });

  it('lists each account with its own reasons once opened', async () => {
    await renderBadge();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconcile-reminder-button'));
    });
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Visa')).toBeInTheDocument();
    expect(screen.getByText('3 transactions, oldest 2026-01-15')).toBeInTheDocument();
    expect(screen.getByText('2 left out of reconciled statements')).toBeInTheDocument();
    expect(screen.getByText('1 older than 45 days')).toBeInTheDocument();
  });

  it('omits a reason with no rows behind it', async () => {
    await renderBadge();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconcile-reminder-button'));
    });
    // acc-2 has no overdue rows, so only acc-1's overdue line appears.
    expect(screen.getAllByText(/older than 45 days/)).toHaveLength(1);
  });

  it('names the window from the response rather than restating it', async () => {
    // The server owns the window; a client that hardcoded 45 would keep saying
    // 45 after the constant moved.
    mockGetStale.mockResolvedValue({ ...summary, staleAfterDays: 60 });
    await renderBadge();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconcile-reminder-button'));
    });
    expect(screen.getByText('1 older than 60 days')).toBeInTheDocument();
  });

  it('opens the account it is reminding about', async () => {
    await renderBadge();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconcile-reminder-button'));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Reconcile')[0]);
    });
    expect(mockPush).toHaveBeenCalledWith('/reconcile?accountId=acc-1');
  });

  it('offers no dismissal, because reconciling is the way it clears', async () => {
    await renderBadge();
    await act(async () => {
      fireEvent.click(screen.getByTestId('reconcile-reminder-button'));
    });
    expect(screen.queryByText(/Dismiss/i)).not.toBeInTheDocument();
  });
  it('re-counts when a reconciliation write is announced', async () => {
    // The badge sits in the header and is never remounted by navigating, so
    // without this it would go on showing the count that prompted the user to
    // reconcile in the first place.
    await renderBadge();
    expect(screen.getByTestId('reconcile-reminder-count')).toHaveTextContent('4');

    mockGetStale.mockResolvedValue({ ...summary, totalCount: 1 });
    await act(async () => {
      notifyReconciliationChanged();
    });

    await waitFor(() =>
      expect(screen.getByTestId('reconcile-reminder-count')).toHaveTextContent('1'),
    );
  });

  it('disappears once the last outstanding row is reconciled', async () => {
    await renderBadge();
    expect(screen.getByTestId('reconcile-reminder-button')).toBeInTheDocument();

    mockGetStale.mockResolvedValue({ ...summary, totalCount: 0, accounts: [] });
    await act(async () => {
      notifyReconciliationChanged();
    });

    await waitFor(() =>
      expect(screen.queryByTestId('reconcile-reminder-button')).not.toBeInTheDocument(),
    );
  });
});
