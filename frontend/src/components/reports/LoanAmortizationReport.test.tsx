import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { LoanAmortizationReport } from './LoanAmortizationReport';

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

const mockGetAllAccounts = vi.fn();
const mockGetAllTransactions = vi.fn();
const mockGetAllPages = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
    getAllPages: (...args: any[]) => mockGetAllPages(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * Render the report and let its two loaders settle inside `act`.
 *
 * The report fetches on mount -- the accounts list and, keyed off it, the
 * selected loan's transactions plus its booked interest -- so a bare
 * `render(...)` leaves those updates landing outside `act` and the assertions
 * run against a tree React has not finished. `frontend/CLAUDE.md`: give the file
 * one helper and use it everywhere.
 */
async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<LoanAmortizationReport />);
  });
  // A second flush, because the two loaders are SEQUENTIAL: the accounts fetch
  // settles inside the first, which seeds the selection, and only then does the
  // history fetch start -- so its resolution lands in a later microtask. One
  // flush leaves those updates outside `act`.
  await act(async () => {});
  return result!;
}

const loanWithSeparateInterest = {
  id: 'loan-1',
  name: 'Mortgage',
  accountType: 'MORTGAGE',
  currentBalance: -100000,
  openingBalance: -120000,
  interestRate: 5.0,
  paymentAmount: 800,
  paymentFrequency: 'MONTHLY',
  interestCategoryId: 'cat-int',
  sourceAccountId: 'src-1',
  isCanadianMortgage: false,
  isVariableRate: false,
  isClosed: false,
};

describe('LoanAmortizationReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', async () => {
    // The accounts fetch never settles, so the skeleton stays -- but the HISTORY
    // loader resolves immediately with nothing selected, and that update landed
    // outside `act` when this rendered synchronously. Flushing it does not hide
    // the first paint: the report is still loading on the half that matters.
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    await renderReport();
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no loan accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No loan or mortgage accounts found/)).toBeInTheDocument();
    });
  });

  it('fetches the loan\'s separately-booked interest expenses (issue #893)', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -100000,
        openingBalance: -120000,
        interestRate: 5.0,
        paymentAmount: 800,
        paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int',
        sourceAccountId: 'src-1',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      // `fetchAllAccountTransactions` pages on `result.pagination.hasMore`, so a
      // fixture without it throws. It used to be omitted here and nothing
      // noticed: the report caught every history failure and rendered an empty
      // one, so this test was green against an error screen.
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockResolvedValue([
      { id: 'i1', transactionDate: '2024-06-01', amount: -300, categoryId: 'cat-int', isTransfer: false },
    ]);

    await renderReport();

    // The report now pulls the loan's interest expenses, scoped to its
    // configured interest category + source account, so its interest matches
    // the loan detail page instead of an analytic estimate.
    await waitFor(() =>
      expect(mockGetAllPages).toHaveBeenCalledWith({
        categoryIds: ['cat-int'],
        accountIds: ['src-1'],
      }),
    );
  });

  it('shows a retriable error when the interest lookup fails, not a zero-interest history', async () => {
    // The failure this surface used to swallow. Its loader caught the rejection
    // and replaced BOTH arrays with `[]`, so a transient 500 on the interest
    // query rendered a complete-looking loan history -- and with the interest
    // list empty, every row took the analytic estimate rather than the booked
    // interest. A failed lookup is not an empty dataset: the report has an
    // error-and-retry state and this is what reaches it.
    mockGetAllAccounts.mockResolvedValue([loanWithSeparateInterest]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockRejectedValue(new Error('interest lookup failed'));

    await renderReport();

    await waitFor(() =>
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    // And nothing that looks like a history: no table, no summary figure.
    expect(screen.queryByText(/Payment History/)).not.toBeInTheDocument();
  });

  it('retries the history load, not only the accounts list', async () => {
    // Both loaders sit behind one button, so a retry that reloaded only the
    // accounts would leave the surface in the error state for ever.
    mockGetAllAccounts.mockResolvedValue([loanWithSeparateInterest]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'p1', transactionDate: '2024-06-01', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    mockGetAllPages.mockRejectedValue(new Error('interest lookup failed'));

    await renderReport();
    await waitFor(() =>
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument(),
    );

    mockGetAllPages.mockResolvedValue([
      { id: 'i1', transactionDate: '2024-06-01', amount: -300, categoryId: 'cat-int', isTransfer: false },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    });

    await waitFor(() =>
      expect(screen.queryByText(/Failed to load report data/)).not.toBeInTheDocument(),
    );
  });

  it('renders account selector and summary with data', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-01', amount: 350, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('renders payment history table header', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Student Loan',
        accountType: 'LOAN',
        currentBalance: -5000,
        openingBalance: -15000,
        interestRate: 3.5,
        paymentAmount: 200,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-03-01', amount: 180, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-04-01', amount: 180, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    });
  });

  it('selects first account by default when multiple accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: true, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    // Both accounts should appear as options
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
  });

  it('filters out non-loan account types', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'chequing-1', name: 'Chequing', accountType: 'CHEQUING',
        currentBalance: 5000, openingBalance: 5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -15000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.queryByText('Chequing')).not.toBeInTheDocument();
  });

  it('shows "No payments found" when account has no transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'New Loan', accountType: 'LOAN',
        currentBalance: -10000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [], pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No payments found for this loan/)).toBeInTheDocument();
    });
  });

  it('displays summary cards with correct values', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -8000, openingBalance: -20000, interestRate: 5.0,
        paymentAmount: 400, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 350, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 350, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
    expect(screen.getByText('Original Amount')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('shows "Not set" when interest rate is null', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'Line of Credit', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      // Multiple "Not set" texts (interestRate, paymentFrequency, paymentAmount are all null)
      const notSetElements = screen.getAllByText('Not set');
      expect(notSetElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays account details section with correct type labels', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'My Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 4.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Account Type')).toBeInTheDocument();
    });
    expect(screen.getByText('Loan')).toBeInTheDocument();
    expect(screen.getByText('Payment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Payment Amount')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows "Closed" status for closed accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Old Loan', accountType: 'LOAN',
        currentBalance: 0, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: true,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-01', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });
  });

  it('renders payment table with correct columns', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('#')).toBeInTheDocument();
    });
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByText('Interest')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
  });

  it('renders payment table with interest from linked transaction splits', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -9000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1', transactionDate: '2024-01-15', amount: 450,
          linkedTransaction: {
            id: 'parent-1',
            splits: [
              { amount: -450, transferAccountId: 'loan-1' },
              { amount: -50, transferAccountId: 'interest-expense' },
            ],
          },
        },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      // Check payment history header shows correct count after transactions load
      expect(screen.getByText(/1 payments made/)).toBeInTheDocument();
    });
  });

  it('shows "Payment History & Projection" header when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment History & Projection')).toBeInTheDocument();
    });
  });

  it('shows "Payment History" header when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Payment History')).toBeInTheDocument();
    });
  });

  it('shows "Projected Future Payments" separator row', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    });
  });

  it('shows Est. Payoff card when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('shows "Est. Total Interest" label when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Est. Total Interest')).toBeInTheDocument();
    });
  });

  it('shows "Total Interest Paid" label when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Total Interest Paid')).toBeInTheDocument();
    });
  });

  it('displays Mortgage account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: true, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 1000, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Mortgage')).toBeInTheDocument();
    });
  });

  it('displays Line of Credit account type correctly', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: 8.0,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Line of Credit')).toBeInTheDocument();
    });
  });

  it('shows a retryable error when loading accounts fails', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
  });

  it('shows a retryable error when loading the payment history fails', async () => {
    // This asserted the opposite until the loader stopped swallowing failures:
    // it expected the report chrome ("Select Loan") to render on a failed
    // transactions load, which is what the old `catch` produced -- a report that
    // looks usable over a history that never arrived, and whose rows then take
    // the analytic interest estimate. "Gracefully" meant "silently".
    //
    // A failed lookup is not an empty dataset, so the failure lands on the
    // report's own error-and-retry state, exactly as an accounts failure does.
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
    });
    expect(screen.queryByText('Select Loan')).not.toBeInTheDocument();
  });

  it('exports CSV and PDF', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToCsv as any).mockClear();
    (exportToPdf as any).mockClear();
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'My Car Loan!', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
        currencyCode: 'CAD',
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Select Loan')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      await act(async () => {
        fireEvent.click(csvBtn);
      });
    }
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
    expect(exportToCsv).toHaveBeenCalled();
  });

  it('toggles show all rows when there are more than 24 payments', async () => {
    const txs = Array.from({ length: 30 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
      amount: 100,
      linkedTransaction: null,
    }));
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -1000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: null, paymentFrequency: null,
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: txs, pagination: { hasMore: false } });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Show all/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Show all/));
    });
    expect(screen.getByText(/Show fewer rows/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText(/Show fewer rows/));
    });
  });

  it('handles WEEKLY, BIWEEKLY, SEMI_MONTHLY, QUARTERLY, YEARLY frequencies', async () => {
    const freqs = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'QUARTERLY', 'YEARLY', 'ACCELERATED_BIWEEKLY', 'ACCELERATED_WEEKLY'];
    for (const freq of freqs) {
      vi.clearAllMocks();
      mockGetAllAccounts.mockResolvedValue([
        {
          id: 'loan-1', name: 'Loan', accountType: 'LOAN',
          currentBalance: -2000, openingBalance: -5000, interestRate: 5.0,
          paymentAmount: 100, paymentFrequency: freq,
          isCanadianMortgage: false, isVariableRate: false, isClosed: false,
        },
      ]);
      mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      const { unmount } = await renderReport();
      await waitFor(() => {
        expect(screen.getByText('Select Loan')).toBeInTheDocument();
      });
      unmount();
    }
  });

  it('does not project when payment cannot cover interest', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -100000, openingBalance: -100000, interestRate: 50,
        paymentAmount: 10, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No payments found/)).toBeInTheDocument();
    });
  });

  it('paginates through transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
    ]);
    // First page has more, second page doesn't
    mockGetAllTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-02-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: false },
      });
    await renderReport();
    await waitFor(() => {
      expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/2 payments made/)).toBeInTheDocument();
    });
  });

  it('exercises every sortable column on the amortization table', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'acc-loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currencyCode: 'CAD',
        currentBalance: -200000,
        interestRate: 5,
        loanTerm: 360,
        loanFrequency: 'MONTHLY',
        loanStartDate: '2020-01-01',
        loanEndDate: '2050-01-01',
        loanPayment: 1500,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 1500, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 1500, linkedTransaction: null },
        { id: 'tx-3', transactionDate: '2024-03-15', amount: 1500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<LoanAmortizationReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('table thead th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
  });

  it('restores the persisted loan selection instead of the first loan', async () => {
    window.localStorage.setItem(
      'monize-reports-loan-amortization-account',
      JSON.stringify('loan-2'),
    );
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
      {
        id: 'loan-2',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetAllPages.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-2');
    });
  });

  it('falls back to the first loan when the persisted account is gone', async () => {
    window.localStorage.setItem(
      'monize-reports-loan-amortization-account',
      JSON.stringify('deleted-loan'),
    );
    mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false,
        isVariableRate: false,
        isClosed: false,
      }]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetAllPages.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-1');
    });
  });
});
