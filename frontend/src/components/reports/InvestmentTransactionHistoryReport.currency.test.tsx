/**
 * Issue #1394: an investment row's money is in the SECURITY's currency.
 *
 * The report used to label every figure with the account's currency (or the
 * reader's) and add the raw numbers into one "Total Volume". These cases pin
 * both halves: each row prints in its own currency, and the KPI is the server's
 * converted answer -- never the arithmetic sum of two currencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import { InvestmentTransactionHistoryReport } from './InvestmentTransactionHistoryReport';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      // The currency is part of the rendering here, deliberately: a mock that
      // dropped it could not tell a EUR figure from a USD one, which is the
      // whole defect.
      formatCurrency: (n: number, currency?: string) =>
        `${currency ?? 'PLN'} ${n.toFixed(2)}`,
      defaultCurrency: 'PLN',
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'PLN',
  }),
}));

const STABLE_RANGE = { start: '2026-01-01', end: '2026-12-31' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetTransactionSummary = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
  },
}));

vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: {
    getTransactionSummary: (...args: unknown[]) => mockGetTransactionSummary(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/** A EUR trade and a USD trade of the SAME numeric amount, in a PLN brokerage. */
const EQUAL_NUMBERS_TWO_CURRENCIES = [
  {
    id: 'tx-eur',
    accountId: 'acc-pln',
    transactionDate: '2026-09-01',
    action: 'BUY',
    quantity: 10,
    price: 100,
    commission: 0,
    totalAmount: 1000,
    amountCurrencyCode: 'EUR',
    priceCurrencyCode: 'EUR',
    commissionCurrencyCode: 'EUR',
    settlementCurrencyCode: 'PLN',
    security: { symbol: 'AAA', name: 'Alpha', currencyCode: 'EUR' },
  },
  {
    id: 'tx-usd',
    accountId: 'acc-pln',
    transactionDate: '2026-09-02',
    action: 'BUY',
    quantity: 10,
    price: 100,
    commission: 0,
    totalAmount: 1000,
    amountCurrencyCode: 'USD',
    priceCurrencyCode: 'USD',
    commissionCurrencyCode: 'USD',
    settlementCurrencyCode: 'PLN',
    security: { symbol: 'BBB', name: 'Beta', currencyCode: 'USD' },
  },
];

function summaryFixture(over: Record<string, unknown> = {}) {
  return {
    currencyCode: 'PLN',
    transactionCount: 2,
    securitiesTraded: 2,
    total: 8092.8,
    knownSubtotal: 8092.8,
    missingPairs: [],
    unknownCount: 0,
    excludedCount: 0,
    fxComplete: true,
    byAction: [
      {
        action: 'BUY',
        count: 2,
        total: 8092.8,
        knownSubtotal: 8092.8,
        missingPairs: [],
        unknownCount: 0,
        excludedCount: 0,
        fxComplete: true,
      },
    ],
    amountCurrencies: ['EUR', 'USD'],
    hasUnknownCurrency: false,
    ...over,
  };
}

let container: HTMLElement;

async function renderReport() {
  await act(async () => {
    ({ container } = render(<InvestmentTransactionHistoryReport />));
  });
  // `getAllBy`: the truncation case pages the same two rows fifty times over,
  // so the symbol is on screen many times.
  await waitFor(() => expect(screen.getAllByText('AAA').length).toBeGreaterThan(0));
}

/**
 * Every figure the page renders, as one flat list of strings.
 *
 * A money cell carries its phone caption in the same `<td>` ("TotalEUR
 * 1000.00 EUR"), so an exact-text query would miss it; asking for substrings
 * over the rendered text is what makes these assertions about the figures
 * rather than about the caption markup around them.
 */
function renderedText(): string {
  return container.textContent ?? '';
}

describe('InvestmentTransactionHistoryReport currencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-pln', name: 'Brokerage', currencyCode: 'PLN', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: EQUAL_NUMBERS_TWO_CURRENCIES,
      pagination: { hasMore: false },
    });
    mockGetTransactionSummary.mockResolvedValue(summaryFixture());
  });

  it("labels each row's amount with the security's currency, not the account's", async () => {
    await renderReport();
    // Two 1,000s that are NOT the same money. Before the fix both read
    // "PLN 1000.00", the account's currency.
    expect(renderedText()).toContain('EUR 1000.00 EUR');
    expect(renderedText()).toContain('USD 1000.00 USD');
    expect(renderedText()).not.toContain('PLN 1000.00');
  });

  it('never shows the arithmetic sum of two currencies as the volume', async () => {
    await renderReport();
    // 2,000 is what adding the raw numbers gives. The answer is the server's
    // conversion at each row's own date.
    expect(renderedText()).not.toContain('PLN 2000.00');
    expect(renderedText()).toContain('PLN 8092.80');
  });

  it('asks the server for the summary over the filtered set', async () => {
    await renderReport();
    expect(mockGetTransactionSummary).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-01-01', endDate: '2026-12-31' }),
    );
  });

  it('relabels the volume and names the missing pair when a rate is absent', async () => {
    mockGetTransactionSummary.mockResolvedValue(
      summaryFixture({
        total: null,
        knownSubtotal: 4339,
        missingPairs: ['USD->PLN'],
        excludedCount: 1,
        fxComplete: false,
        byAction: [
          {
            action: 'BUY',
            count: 2,
            total: null,
            knownSubtotal: 4339,
            missingPairs: ['USD->PLN'],
            unknownCount: 0,
            excludedCount: 1,
            fxComplete: false,
          },
        ],
      }),
    );
    await renderReport();

    // The caption stops claiming a total, the subtotal carries the marker, and
    // the withheld figure is not replaced by the partial one under the old name.
    expect(screen.getByText('Known Volume')).toBeInTheDocument();
    expect(screen.queryByText('Total Volume')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('partial-total-marker').length).toBeGreaterThanOrEqual(1);
    expect(renderedText()).toContain('PLN 4339.00');
  });

  it('renders an unknown amount rather than guessing a currency for a row with no security', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-none',
          accountId: 'acc-pln',
          transactionDate: '2026-09-03',
          action: 'INTEREST',
          quantity: null,
          price: null,
          commission: 0,
          totalAmount: 40,
          amountCurrencyCode: null,
          priceCurrencyCode: null,
          commissionCurrencyCode: null,
          settlementCurrencyCode: 'PLN',
          security: null,
        },
      ],
      pagination: { hasMore: false },
    });
    await act(async () => {
      render(<InvestmentTransactionHistoryReport />);
    });
    await waitFor(() => expect(screen.getByText(/Transaction History/)).toBeInTheDocument());

    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).not.toContain('PLN 40.00');
  });

  it('counts a voided row in the card, so the card and the heading agree', async () => {
    // The register lists a voided trade, so the KPI counts it: a card reading
    // one over a table of two is the defect. Its money is a known zero, so the
    // volume is the surviving trade's alone and the total stays complete.
    mockGetTransactions.mockResolvedValue({
      data: [
        EQUAL_NUMBERS_TWO_CURRENCIES[0],
        { ...EQUAL_NUMBERS_TWO_CURRENCIES[1], status: 'VOID' },
      ],
      pagination: { hasMore: false },
    });
    mockGetTransactionSummary.mockResolvedValue(
      summaryFixture({
        transactionCount: 2,
        total: 4339,
        knownSubtotal: 4339,
        byAction: [
          {
            action: 'BUY',
            count: 2,
            total: 4339,
            knownSubtotal: 4339,
            missingPairs: [],
            unknownCount: 0,
            excludedCount: 0,
            fxComplete: true,
          },
        ],
      }),
    );
    await renderReport();

    const countCard = screen.getByText('Total Transactions').parentElement;
    expect(countCard?.textContent).toContain('2');
    expect(screen.getByText('Transaction History (2)')).toBeInTheDocument();
    expect(screen.queryByTestId('truncated-notice')).not.toBeInTheDocument();
    expect(screen.getByText('Total Volume')).toBeInTheDocument();
    expect(renderedText()).toContain('PLN 4339.00');
  });

  it('says the table is truncated while the KPIs still cover everything', async () => {
    // Every fetched page reports more to come, so the client stops at its cap.
    // Unique ids per page: a repeated React key is a warning this harness fails
    // on, and it would say nothing about truncation.
    mockGetTransactions.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        data: EQUAL_NUMBERS_TWO_CURRENCIES.map((tx) => ({
          ...tx,
          id: `${tx.id}-p${page}`,
        })),
        pagination: { hasMore: true },
      }),
    );
    mockGetTransactionSummary.mockResolvedValue(
      summaryFixture({ transactionCount: 12345 }),
    );
    await renderReport();

    expect(screen.getByTestId('truncated-notice')).toBeInTheDocument();
    // The count card is the server's, not the number of rows on screen.
    expect(renderedText()).toContain('12345');
  });

  it('does not claim truncation when every page was fetched', async () => {
    await renderReport();
    expect(screen.queryByTestId('truncated-notice')).not.toBeInTheDocument();
  });
});
