import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetAlertList } from './BudgetAlertList';
import type { BudgetAlert } from '@/types/budget';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/budgets',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** A `YYYY-MM-DD` date `offset` days from today, on the local clock. */
const daysFromToday = (offset: number): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const makeAlert = (overrides: Partial<BudgetAlert> = {}): BudgetAlert => ({
  id: 'alert-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  alertType: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('BudgetAlertList', () => {
  const defaultProps = {
    alerts: [] as BudgetAlert[],
    isLoading: false,
    onMarkRead: vi.fn(),
    onMarkAllRead: vi.fn(),
    onDismiss: vi.fn(),
    onUndoDismiss: vi.fn(),
    dismissingIds: new Set<string>(),
    collapsingIds: new Set<string>(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the alert list container', () => {
    render(<BudgetAlertList {...defaultProps} />);

    expect(screen.getByTestId('alert-list')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<BudgetAlertList {...defaultProps} isLoading={true} />);

    expect(screen.getByText('Loading alerts...')).toBeInTheDocument();
  });

  it('shows empty state when no alerts', () => {
    render(<BudgetAlertList {...defaultProps} />);

    expect(screen.getByTestId('no-alerts')).toHaveTextContent('No alerts');
  });

  it('renders alert items', () => {
    const alerts = [
      makeAlert({ id: 'a1', title: 'Groceries over budget', severity: 'critical' }),
      makeAlert({ id: 'a2', title: 'Dining near limit', severity: 'warning' }),
    ];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    expect(screen.getByText('Groceries over budget')).toBeInTheDocument();
    expect(screen.getByText('Dining near limit')).toBeInTheDocument();
  });

  it('shows severity badges for each alert', () => {
    const alerts = [
      makeAlert({ id: 'a1', severity: 'critical' }),
      makeAlert({ id: 'a2', severity: 'warning' }),
      makeAlert({ id: 'a3', severity: 'success' }),
      makeAlert({ id: 'a4', severity: 'info' }),
    ];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    const badges = screen.getAllByTestId('severity-badge');
    expect(badges).toHaveLength(4);
    expect(badges[0]).toHaveTextContent('Critical');
    expect(badges[1]).toHaveTextContent('Warning');
    expect(badges[2]).toHaveTextContent('Good News');
    expect(badges[3]).toHaveTextContent('Info');
  });

  it('shows unread dots for unread alerts', () => {
    const alerts = [
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: true }),
    ];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    const unreadDots = screen.getAllByTestId('unread-dot');
    expect(unreadDots).toHaveLength(1);
  });

  it('shows unread count in header', () => {
    const alerts = [
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: false }),
      makeAlert({ id: 'a3', isRead: true }),
    ];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    expect(screen.getByText('2 unread')).toBeInTheDocument();
  });

  it('shows mark all read button when there are unread alerts', () => {
    const alerts = [makeAlert({ id: 'a1', isRead: false })];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    expect(screen.getByTestId('mark-all-read')).toBeInTheDocument();
  });

  it('hides mark all read button when all alerts are read', () => {
    const alerts = [makeAlert({ id: 'a1', isRead: true })];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    expect(screen.queryByTestId('mark-all-read')).not.toBeInTheDocument();
  });

  it('calls onMarkAllRead when mark all read is clicked', () => {
    const onMarkAllRead = vi.fn();
    const alerts = [makeAlert({ id: 'a1', isRead: false })];

    render(
      <BudgetAlertList {...defaultProps} alerts={alerts} onMarkAllRead={onMarkAllRead} />,
    );

    fireEvent.click(screen.getByTestId('mark-all-read'));

    expect(onMarkAllRead).toHaveBeenCalled();
  });

  it('calls onMarkRead and navigates when unread alert is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const alerts = [
      makeAlert({ id: 'a1', budgetId: 'budget-123', isRead: false }),
    ];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('alert-item-a1'));

    expect(onMarkRead).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('navigates without marking read when read alert is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const alerts = [
      makeAlert({ id: 'a1', budgetId: 'budget-456', isRead: true }),
    ];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('alert-item-a1'));

    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-456');
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const alerts = [makeAlert({ id: 'a1' })];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId('dismiss-alert-a1'));

    expect(onDismiss).toHaveBeenCalledWith('a1');
  });

  it('does not navigate when dismiss button is clicked', () => {
    const onClose = vi.fn();
    const alerts = [makeAlert({ id: 'a1' })];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('dismiss-alert-a1'));

    expect(onClose).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates to bills page when BILL_DUE alert is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const alerts = [
      makeAlert({
        id: 'bill-alert-1',
        alertType: 'BILL_DUE',
        severity: 'info',
        title: 'Netflix due tomorrow',
        message: 'USD 15.99 due on 2026-02-21',
        budgetId: '',
        isRead: false,
      }),
    ];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('alert-item-bill-alert-1'));

    expect(onMarkRead).toHaveBeenCalledWith('bill-alert-1');
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  // ---- BILL_DUE copy comes from the alert's data, in the reader's language ----
  //
  // The row is written by a cron under no request locale, so a stored sentence
  // cannot be translated after the fact (issue #1247). `title`/`message` stay on
  // the row as the fallback for a consumer with no catalog.

  const billDueAlert = (data: Record<string, unknown>): BudgetAlert =>
    makeAlert({
      id: 'alert-bill',
      alertType: 'BILL_DUE',
      severity: 'info',
      title: 'STORED ENGLISH TITLE',
      message: 'STORED ENGLISH MESSAGE',
      data,
    });

  it('composes a bill-due alert from its structured data', () => {
    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={[
          billDueAlert({
            billId: 'st-1',
            payeeName: 'Power Co',
            amount: 312.65,
            amountComplete: true,
            dueDate: daysFromToday(3),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Power Co due in 3 days')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`312\\.65 due on ${daysFromToday(3)}`)),
    ).toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH TITLE')).not.toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH MESSAGE')).not.toBeInTheDocument();
  });

  it('says the amount is unavailable rather than leaving a blank or a stale figure', () => {
    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={[
          billDueAlert({
            billId: 'st-1',
            payeeName: 'Monthly ETF buy',
            amount: null,
            amountComplete: false,
            dueDate: daysFromToday(0),
            currencyCode: 'CAD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Monthly ETF buy due today')).toBeInTheDocument();
    expect(
      screen.getByText(
        `Amount unavailable (no current exchange rate), due on ${daysFromToday(0)}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH MESSAGE')).not.toBeInTheDocument();
  });

  it('says tomorrow rather than "in 1 days"', () => {
    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={[
          billDueAlert({
            payeeName: 'Netflix',
            amount: 15.99,
            amountComplete: true,
            dueDate: daysFromToday(1),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Netflix due tomorrow')).toBeInTheDocument();
  });

  /**
   * The row lives until it is dismissed, so the copy is counted from `dueDate`
   * against the reader's clock -- a stored "in 3 days" would still say three days
   * a week later.
   */
  it('says overdue once the due date has passed', () => {
    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={[
          billDueAlert({
            payeeName: 'Power Co',
            amount: 312.65,
            amountComplete: true,
            dueDate: daysFromToday(-2),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Power Co overdue')).toBeInTheDocument();
  });

  it('falls back to the stored copy for a row written before the data existed', () => {
    // Absent is "no information", not a licence to render nothing: a row from an
    // older release carries only its English sentence.
    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={[billDueAlert({ billId: 'st-1', payeeName: 'Power Co' })]}
      />,
    );

    expect(screen.getByText('STORED ENGLISH TITLE')).toBeInTheDocument();
    expect(screen.getByText('STORED ENGLISH MESSAGE')).toBeInTheDocument();
  });

  it('displays alert message text', () => {
    const alerts = [
      makeAlert({
        id: 'a1',
        message: 'You have used 85% of your Groceries budget ($425 of $500).',
      }),
    ];

    render(<BudgetAlertList {...defaultProps} alerts={alerts} />);

    expect(
      screen.getByText('You have used 85% of your Groceries budget ($425 of $500).'),
    ).toBeInTheDocument();
  });

  it('shows inline undo when alert is in dismissingIds', () => {
    const alerts = [
      makeAlert({ id: 'a1' }),
      makeAlert({ id: 'a2', title: 'Second alert' }),
    ];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        dismissingIds={new Set(['a1'])}
      />,
    );

    // Dismissed alert shows undo, not normal content
    expect(screen.queryByTestId('alert-item-a1')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();
    // Other alert is still normal
    expect(screen.getByTestId('alert-item-a2')).toBeInTheDocument();
  });

  it('calls onUndoDismiss when undo is clicked', () => {
    const onUndoDismiss = vi.fn();
    const alerts = [makeAlert({ id: 'a1' })];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        dismissingIds={new Set(['a1'])}
        onUndoDismiss={onUndoDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('undo-dismiss-a1'));

    expect(onUndoDismiss).toHaveBeenCalledWith('a1');
  });

  it('excludes dismissing alerts from unread count', () => {
    const alerts = [
      makeAlert({ id: 'a1', isRead: false }),
      makeAlert({ id: 'a2', isRead: false }),
    ];

    render(
      <BudgetAlertList
        {...defaultProps}
        alerts={alerts}
        dismissingIds={new Set(['a1'])}
      />,
    );

    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });
});
