import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UpcomingBills } from './UpcomingBills';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

function futureDateStr(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string {
  return futureDateStr(0);
}

const defaultMaxItems = 20;

describe('UpcomingBills', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={true} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Upcoming Bills & Deposits')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no upcoming items', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No overdue or upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('renders upcoming bill with Tomorrow label', () => {
    const transactions = [
      {
        id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: false,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('renders Today label for bills due today', () => {
    const transactions = [
      {
        id: '1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
        nextDueDate: todayStr(), isActive: true, autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('renders days-away label for upcoming bills', () => {
    const transactions = [
      {
        id: '1', name: 'Insurance', amount: -200, currencyCode: 'CAD',
        nextDueDate: futureDateStr(5), isActive: true, autoPost: true,
        reminderDaysBefore: 7,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('5 days')).toBeInTheDocument();
  });

  // The widget lists occurrences and nothing else: the summed "Total due" row
  // went in #1264 and "Total incoming" followed it, so no row here stands for
  // more than the one occurrence printed beside it.
  it('shows no summary rows for bills, deposits or unknown occurrences', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '3', name: 'Payroll', amount: 3000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '4', name: 'Dividend', amount: 250, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // The per-item amounts stay; every summary line goes.
    expect(screen.getByText('-$15.99')).toBeInTheDocument();
    expect(screen.getByText('+$3000.00')).toBeInTheDocument();
    expect(screen.queryByText(/Total/i)).not.toBeInTheDocument();
    // Neither summed bucket is drawn, in whole or in part.
    expect(screen.queryByText('-$25.98')).not.toBeInTheDocument();
    expect(screen.queryByText('+$3250.00')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
  });

  it('renders an occurrence of unknown direction as unknown, with no total beside it', () => {
    // A mixed-sign split whose investment line cannot be priced could be a bill
    // or a deposit, so the row says so rather than being painted red or green
    // (issue #1247 re-audit). With the totals gone there is no bucket left for
    // it to be silently excluded from either.
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Payroll', amount: 3000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      {
        id: '3', name: 'Sell shares, pay the fee', amount: 10, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true, isSplit: true,
        effectiveAmount: null, effectiveAmountComplete: false,
        effectiveDirectionAmount: null,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    expect(screen.queryByText(/Total/i)).not.toBeInTheDocument();
  });

  it('shows a Deposit badge for incoming schedules', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Deposit')).toBeInTheDocument();
  });

  it('shows Transfer badge for transfer transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  // Issue #1124: a schedule left at 0 because the amount is not known yet was
  // badged "Deposit" and printed as a green "+$0.00".
  it('badges a zero-amount schedule as a reminder, not a deposit', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Card Payment', amount: 0, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false, isTransfer: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Reminder')).toBeInTheDocument();
    expect(screen.queryByText('Deposit')).not.toBeInTheDocument();
    // No sign, and not painted as money arriving.
    const amount = screen.getByText('$0.00');
    expect(amount.className).toContain('text-gray-500');
  });

  it('keeps a zero-amount transfer badged as a transfer', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Card Payment', amount: 0, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false, isTransfer: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('filters out inactive scheduled transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Active Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Inactive Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: false, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Active Bill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Bill')).not.toBeInTheDocument();
  });

  it('filters out transactions beyond their reminder window', () => {
    const transactions = [
      { id: '1', name: 'Far Future Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(10), isActive: true, autoPost: true, reminderDaysBefore: 3 },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No overdue or upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('navigates to bills page on title click', () => {
    render(<UpcomingBills accounts={[]} scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('Upcoming Bills & Deposits'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('navigates to bills page on View all bills link click', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('View all bills & deposits'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('navigates to bills page with postBillId when a bill row is clicked', () => {
    const transactions = [
      { id: 'bill-42', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('Netflix'));
    expect(mockPush).toHaveBeenCalledWith('/bills?postBillId=bill-42');
  });

  it('navigates with postBillId when Enter is pressed on a focused bill row', () => {
    const transactions = [
      { id: 'bill-7', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const row = screen.getByRole('button', { name: /Spotify/i });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockPush).toHaveBeenCalledWith('/bills?postBillId=bill-7');
  });

  it('highlights the row edge on hover, matching the Top Movers widget', () => {
    const transactions = [
      { id: 'bill-9', name: 'Hydro', amount: -60, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const row = screen.getByRole('button', { name: /Hydro/i });
    expect(row.className).toContain('hover:border-blue-400');
    expect(row.className).toContain('dark:hover:border-blue-500');
  });

  it('shows payee name when available', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Phone Bill', amount: -80, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        payeeName: 'AT&T',
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('AT&T')).toBeInTheDocument();
  });

  it('does not show Manual badge when autoPost is true', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });

  it('shows bill amount with negative sign and red color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The item row is the only place the amount appears -- no total section.
    const amountEl = screen.getByText('-$15.99');
    expect(amountEl.className).toContain('text-red');
  });

  it('shows deposit amount with plus sign and green color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The item row is the only place the amount appears -- no total section.
    const amountEl = screen.getByText('+$5000.00');
    expect(amountEl.className).toContain('text-green');
  });

  it('sorts items by due date ascending', () => {
    const transactions = [
      { id: '1', name: 'Later Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(3), isActive: true, autoPost: true },
      { id: '2', name: 'Sooner Bill', amount: -30, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const items = screen.getAllByText(/Bill/);
    // The sooner bill should appear before the later one
    const soonerIdx = items.findIndex(el => el.textContent === 'Sooner Bill');
    const laterIdx = items.findIndex(el => el.textContent === 'Later Bill');
    expect(soonerIdx).toBeLessThan(laterIdx);
  });

  it('shows override amount instead of default when nextOverride exists', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Modified Bill', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: -75 },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Should show the override amount (-75), not the default (-100)
    expect(screen.getAllByText('-$75.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('-$100.00')).not.toBeInTheDocument();
  });

  it('uses override amount for type determination (bill vs deposit)', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Overridden to Deposit', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: 50 },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Override amount is positive, so it should be classified as a deposit
    expect(screen.getByText('Deposit')).toBeInTheDocument();
  });

  /**
   * `nextDueDate` is the recurrence slot; an override addressed to that slot can
   * move the occurrence. Reading the slot announces a payment on a day the user
   * has already changed (issue #1247).
   */
  it('shows the date an override moved the next occurrence to', () => {
    const slot = futureDateStr(1);
    const movedTo = futureDateStr(4);
    const transactions = [
      {
        id: '1', name: 'Moved Bill', amount: -100, currencyCode: 'CAD',
        nextDueDate: slot, isActive: true, autoPost: true,
        reminderDaysBefore: 7,
        nextOverride: { amount: -75, overrideDate: movedTo },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.getByText('4 days')).toBeInTheDocument();
    expect(screen.queryByText('Tomorrow')).not.toBeInTheDocument();
  });

  it('drops an occurrence an override moved beyond the reminder window', () => {
    const transactions = [
      {
        id: '1', name: 'Pushed Out', amount: -100, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: true,
        reminderDaysBefore: 3,
        nextOverride: { amount: -75, overrideDate: futureDateStr(40) },
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    expect(screen.queryByText('Pushed Out')).not.toBeInTheDocument();
  });

  it('uses default amount when nextOverride is null', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Normal Bill', amount: -200, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: null,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getAllByText('-$200.00').length).toBeGreaterThanOrEqual(1);
  });

  it('truncates list at maxItems and shows +N more link', () => {
    const dateStr = futureDateStr(1);
    const transactions = Array.from({ length: 6 }, (_, i) => ({
      id: String(i + 1), name: `Bill ${i + 1}`, amount: -10, currencyCode: 'CAD',
      nextDueDate: dateStr, isActive: true, autoPost: true,
    })) as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={4} />);
    // Only 4 of 6 items should be visible
    expect(screen.getByText('Bill 1')).toBeInTheDocument();
    expect(screen.getByText('Bill 4')).toBeInTheDocument();
    expect(screen.queryByText('Bill 5')).not.toBeInTheDocument();
    expect(screen.queryByText('Bill 6')).not.toBeInTheDocument();
    // "+2 more" link should appear
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('does not show +N more when items fit within maxItems', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Bill A', amount: -10, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Bill B', amount: -20, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={5} />);
    expect(screen.getByText('Bill A')).toBeInTheDocument();
    expect(screen.getByText('Bill B')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });

  // ---- Effective amounts (issue #1247) ----

  it("shows the server's effective amount for an FX-sensitive schedule", () => {
    // A scheduled SELL: the cash impact is an inflow, and the schedule settles
    // in the brokerage's cash currency. The occurrence is priced at today's
    // rate, not the one pinned when the row was written.
    //
    // The row is now the only figure the widget prints for this occurrence, so
    // it is the one that has to be re-priced: with the summary rows gone
    // (#1264 removed "Total due", and "Total incoming" followed) a stale
    // snapshot here has nothing left to disagree with, only the user.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF sale',
        // The security-currency cash impact, pinned at 1.50 when it was EUR.
        amount: 1000,
        currencyCode: 'CAD',
        isInvestment: true,
        // The security is USD now, and USD -> CAD resolves at 1.35.
        effectiveAmount: 1350,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // Exactly one figure, and it reads 1,350.
    expect(screen.getAllByText('+$1350.00')).toHaveLength(1);
    // Neither the pre-FX impact nor the stale 1.50 figure.
    expect(screen.queryByText('+$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+$1500.00')).not.toBeInTheDocument();
  });

  it('marks an unresolvable occurrence unavailable without touching its neighbours', () => {
    // The unpriceable row renders as unavailable; the resolvable one beside it
    // still prints its own figure. No total is drawn for either.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF sale',
        amount: 1000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
      {
        id: '2',
        name: 'Dividend',
        amount: 15.99,
        currencyCode: 'CAD',
        effectiveAmount: 15.99,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // The row itself carries the unavailable marker, not a stale figure.
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    expect(screen.queryByText('+$1000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+$1500.00')).not.toBeInTheDocument();
    // No summary row survives to fold the missing item into a figure.
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    // The resolvable row, once: nothing invented a total from the half it knew.
    expect(screen.getAllByText('+$15.99')).toHaveLength(1);
  });

  it('does not let an unknown amount move an account into the negative-balance warning', () => {
    // A running balance built from an unknown amount is unknown, so the
    // projection stops for that account rather than treating the item as free.
    const transactions = [
      {
        id: '1',
        name: 'Monthly ETF buy',
        accountId: 'acc-1',
        amount: -1000,
        currencyCode: 'CAD',
        isInvestment: true,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(1),
        isActive: true,
        autoPost: true,
      },
      {
        id: '2',
        name: 'Netflix',
        accountId: 'acc-1',
        amount: -15.99,
        currencyCode: 'CAD',
        effectiveAmount: -15.99,
        effectiveAmountComplete: true,
        effectiveCurrencyCode: 'CAD',
        nextDueDate: futureDateStr(2),
        isActive: true,
        autoPost: true,
      },
    ] as any[];
    const accounts = [
      {
        id: 'acc-1',
        accountType: 'CHECKING',
        currentBalance: 10,
        futureTransactionsSum: 0,
      },
    ] as any[];

    render(<UpcomingBills accounts={accounts} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);

    // With the unknown item skipped and the projection stopped, no row claims a
    // measured overdraft.
    expect(
      screen.queryByTitle('This payment may overdraw the account'),
    ).not.toBeInTheDocument();
  });

  it('prioritizes manual items over auto-post items on the same day', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Manual Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills accounts={[]} scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const billElements = screen.getAllByText(/Bill/);
    const manualIdx = billElements.findIndex(el => el.textContent === 'Manual Bill');
    const autoIdx = billElements.findIndex(el => el.textContent === 'Auto Bill');
    expect(manualIdx).toBeLessThan(autoIdx);
  });
});
