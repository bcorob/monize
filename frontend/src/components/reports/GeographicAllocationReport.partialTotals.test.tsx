import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { GeographicAllocationReport } from './GeographicAllocationReport';

/**
 * What the report's "Total" figures say when a holding could not be converted.
 *
 * The sibling `*.mobileWrapped.test.tsx` fixture converts everything (its
 * `convertToDefault` is the identity), so it can say nothing at all about the
 * partial case -- which is how the region and exchange footers came to print a
 * possibly-partial `totalValue` bare while the summary card directly above them
 * marked the same number with an asterisk. This file makes one currency
 * unrateable and holds the three surfaces to one answer.
 *
 * The country view is deliberately NOT expected to carry that marker: its total
 * is `countryResp.totalPortfolioValue`, a server-side look-through aggregate,
 * and `missingCurrencies` describes the client-side conversion of the holdings.
 * Marking it would attach one aggregate's gaps to another's number. The last
 * case here pins that distinction so a later change cannot quietly "finish" the
 * job with the wrong marker.
 */

const mockPush = vi.fn();
let router: { push: typeof mockPush; replace: () => void; back: () => void; prefetch: () => void };
vi.mock('next/navigation', () => ({
  useRouter: () => {
    router ??= { push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
    return router;
  },
  usePathname: () => '/reports/geographic-allocation',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ reportId: 'geographic-allocation' }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});

// JPY has no rate to CAD, so the Tokyo holding is excluded from every converted
// total: `null`, never a zero standing in for an unknown.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number, from: string) => (from === 'JPY' ? null : amount),
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Pie: ({ children }: any) => <div>{children}</div>,
  Bar: ({ children }: any) => <div>{children}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetSecurities = vi.fn();
const mockGetCountryWeightings = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getCountryWeightings: (...args: any[]) => mockGetCountryWeightings(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// 2000 + 3000 convert; the 4000 in JPY does not. So every converted total is
// 5000 with a 4000 hole in it -- the shape a bare "Total" cell misreports.
const HOLDINGS = [
  { securityId: 's-nasdaq', currencyCode: 'USD', quantity: 1, marketValue: 2000 },
  { securityId: 's-tsx', currencyCode: 'CAD', quantity: 1, marketValue: 3000 },
  { securityId: 's-tyo', currencyCode: 'JPY', quantity: 1, marketValue: 4000 },
];

const SECURITIES = [
  { id: 's-nasdaq', symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', isActive: true },
  { id: 's-tsx', symbol: 'RY.TO', name: 'Royal Bank of Canada', exchange: 'TSX', isActive: true },
  { id: 's-tyo', symbol: '6758.T', name: 'Sony Group', exchange: 'TYO', isActive: true },
];

const COUNTRY_WEIGHTINGS = {
  items: [
    { country: 'United States', directValue: 0, etfValue: 6000, totalValue: 6000, percentage: 60 },
    { country: 'Canada', directValue: 0, etfValue: 3000, totalValue: 3000, percentage: 30 },
  ],
  totalPortfolioValue: 10000,
  totalDirectValue: 0,
  totalEtfValue: 9000,
  unclassifiedValue: 1000,
};

async function renderReport(country: object = COUNTRY_WEIGHTINGS) {
  mockGetPortfolioSummary.mockResolvedValue({ holdings: HOLDINGS });
  mockGetInvestmentAccounts.mockResolvedValue([]);
  mockGetSecurities.mockResolvedValue(SECURITIES);
  mockGetCountryWeightings.mockResolvedValue(country);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<GeographicAllocationReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

async function switchView(name: 'By Exchange' | 'By Country') {
  await act(async () => {
    fireEvent.click(screen.getByText(name));
  });
}

const footerTotalCell = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tfoot td')).find((cell) =>
    /Market Value/.test(cell.textContent ?? ''),
  )!;

describe('GeographicAllocationReport partial totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('marks the summary card total as a subtotal', async () => {
    const container = await renderReport();

    const card = container.querySelector('[data-testid="partial-total"]')!;
    expect(card).toBeInTheDocument();
    // The card uses the compact formatter; the footers use the full one. Both
    // report the same 5000 subtotal.
    expect(card.textContent).toContain('$5000');
    // The visible symbol AND the accessible suffix: the symbol alone is
    // `aria-hidden`, so on its own it tells a screen reader nothing.
    expect(card.querySelector('[data-testid="partial-total-marker"]')).toBeInTheDocument();
    expect(card.textContent).toContain('partial total');
  });

  it('marks the region footer total, which is the same figure', async () => {
    const container = await renderReport();

    const cell = footerTotalCell(container);
    expect(cell.textContent).toContain('$5000.00');
    expect(cell.querySelector('[data-testid="partial-total"]')).toBeInTheDocument();
    expect(cell.querySelector('[data-testid="partial-total-marker"]')).toBeInTheDocument();
    expect(cell.textContent).toContain('partial total');
  });

  it('marks the exchange footer total, which is the same figure again', async () => {
    const container = await renderReport();
    await switchView('By Exchange');
    await waitFor(() => expect(screen.getByText('NASDAQ')).toBeInTheDocument());

    const cell = footerTotalCell(container);
    expect(cell.textContent).toContain('$5000.00');
    expect(cell.querySelector('[data-testid="partial-total"]')).toBeInTheDocument();
    expect(cell.querySelector('[data-testid="partial-total-marker"]')).toBeInTheDocument();
    expect(cell.textContent).toContain('partial total');
  });

  it('names the currency that could not be converted, so the reader can fix it', async () => {
    const container = await renderReport();

    // "incomplete" is not something a reader can act on; the currency is. The
    // explanation reaches the reader through the marker's tooltip, whose text
    // is exposed as the trigger's accessible name rather than as page text.
    const explanations = Array.from(
      container.querySelectorAll('[data-testid="partial-total"] button[aria-label]'),
    ).map((button) => button.getAttribute('aria-label') ?? '');

    expect(explanations.length).toBeGreaterThan(0);
    for (const explanation of explanations) {
      expect(explanation).toContain('JPY');
      expect(explanation).toContain('CAD');
    }
  });

  it('leaves the country footer unmarked, because its total is another aggregate', async () => {
    const container = await renderReport();
    await switchView('By Country');
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());

    // The server's look-through total, whole as far as this component knows --
    // and visibly NOT the 5000 the other two footers report, which is exactly
    // why the client-side marker must not be attached to it.
    const cell = footerTotalCell(container);
    expect(cell.textContent).toContain('$10000.00');
    expect(cell.querySelector('[data-testid="partial-total"]')).toBeNull();
  });

  it('relabels the country footer from the server flag and names what is missing', async () => {
    const container = await renderReport({
      ...COUNTRY_WEIGHTINGS,
      totalPortfolioValue: null,
      knownSubtotal: 10000,
      valuationComplete: false,
      unpricedSymbols: ['NOP'],
      missingRatePairs: ['JPY->CAD'],
    });
    await switchView('By Country');
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());

    const cell = footerTotalCell(container);
    expect(cell.textContent).toContain('$10000.00');
    expect(screen.getByText('Known Value')).toBeInTheDocument();
    const note = screen.getByTestId('weighting-partial-note');
    expect(note.textContent).toContain('NOP');
    expect(note.textContent).toContain('JPY->CAD');
  });
});
