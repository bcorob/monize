import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { DuplicateTransactionReport } from './DuplicateTransactionReport';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '3m',
    setDateRange: vi.fn(),
    resolvedRange: { start: '2025-01-01', end: '2025-03-31' },
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', async (importOriginal) => ({
  // The real module for the rest: `useDateFormat` formats the row dates through
  // its `formatDate`, and ExportDropdown merges classes with its `cn`.
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetDuplicateTransactions = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getDuplicateTransactions: (...args: any[]) => mockGetDuplicateTransactions(...args),
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

describe('DuplicateTransactionReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetDuplicateTransactions.mockReturnValue(new Promise(() => {}));
    render(<DuplicateTransactionReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders clean message when no duplicates found', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 0, highCount: 0, mediumCount: 0, lowCount: 0, potentialSavings: 0 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText(/No potential duplicate transactions found/)).toBeInTheDocument();
    });
  });

  it('renders duplicate groups with data', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'high',
          reason: 'Same date, amount, and payee',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: 'Store A', amount: -50, accountName: 'Chequing' },
            { id: 'tx-2', transactionDate: '2025-02-01', payeeName: 'Store A', amount: -50, accountName: 'Chequing' },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 1, mediumCount: 0, lowCount: 0, potentialSavings: 50 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('high confidence')).toBeInTheDocument();
    });
    expect(screen.getByText('Potential Duplicates')).toBeInTheDocument();
    expect(screen.getByText('High Confidence')).toBeInTheDocument();
  });

  it('opens the register on that exact payee, as one quoted term', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'high',
          reason: 'Same date, amount, and payee',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: 'Costco Gas', amount: -50, accountName: 'Chequing' },
            { id: 'tx-2', transactionDate: '2025-02-01', payeeName: 'Costco Gas', amount: -50, accountName: 'Chequing' },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 1, mediumCount: 0, lowCount: 0, potentialSavings: 50 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Costco Gas').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText('Costco Gas')[0]);
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?search=payee%3A%3D%22Costco%20Gas%22',
    );
  });

  it('renders summary cards', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 3, highCount: 1, mediumCount: 2, lowCount: 0, potentialSavings: 150 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('Potential Duplicates')).toBeInTheDocument();
    });
    expect(screen.getByText('High Confidence')).toBeInTheDocument();
    expect(screen.getByText('Medium Confidence')).toBeInTheDocument();
    expect(screen.getByText('Potential Impact')).toBeInTheDocument();
  });

  it('renders medium confidence group with correct styles', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'medium',
          reason: 'Same date and amount',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: 'Store B', amount: -30, accountName: 'Savings' },
            { id: 'tx-2', transactionDate: '2025-02-02', payeeName: 'Store B', amount: -30, accountName: 'Savings' },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 0, mediumCount: 1, lowCount: 0, potentialSavings: 30 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('medium confidence')).toBeInTheDocument();
    });
    expect(screen.getByText('Same date and amount')).toBeInTheDocument();
    expect(screen.getByText('2 transactions')).toBeInTheDocument();
  });

  it('renders low confidence group', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'low',
          reason: 'Same amount within date range',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: 'Store C', amount: 20, accountName: 'Chequing', description: 'Refund' },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 0, mediumCount: 0, lowCount: 1, potentialSavings: 20 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('low confidence')).toBeInTheDocument();
    });
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });

  it('renders transaction without payeeName as Unknown', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'high',
          reason: 'Test',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: null, amount: -10, accountName: null },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 1, mediumCount: 0, lowCount: 0, potentialSavings: 10 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
    expect(screen.getByText('Unknown account')).toBeInTheDocument();
  });

  it('renders info box about duplicate detection', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 0, highCount: 0, mediumCount: 0, lowCount: 0, potentialSavings: 0 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('How duplicates are detected:')).toBeInTheDocument();
    });
  });

  it('renders sensitivity selector', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 0, highCount: 0, mediumCount: 0, lowCount: 0, potentialSavings: 0 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('Sensitivity:')).toBeInTheDocument();
    });
  });

  it('surfaces a retryable error state when the API fails', async () => {
    mockGetDuplicateTransactions.mockRejectedValue(new Error('Network error'));
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  // The toolbar holds the date controls, so it stays mounted while the report
  // reloads and after a failed load: an early return for either state would
  // unmount it, and the focus of whoever is using it.
  it('keeps the toolbar mounted while loading and after a failed load', async () => {
    let fail!: (error: Error) => void;
    mockGetDuplicateTransactions.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    render(<DuplicateTransactionReport />);
    const toolbar = screen.getByTestId('date-range-selector');
    expect(document.querySelector('.animate-pulse')).toBeTruthy();

    await act(async () => {
      fail(new Error('boom'));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('date-range-selector')).toBe(toolbar);
  });

});
