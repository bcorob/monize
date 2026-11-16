import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';

/**
 * The phone layout of the Portfolio Value report's Portfolio Breakdown table
 * (holdings, cash, total and gain/loss per account).
 *
 * It is ONE tree restyled by CSS (mechanism A): below `sm` each row wraps into a
 * grid card and the column header row is replaced by a sort strip, from `sm` up
 * it is the ordinary table. jsdom applies no media queries, so both header rows
 * and every phone caption are in the DOM here at all times -- which is what lets
 * these assertions read the phone markup without emulating a viewport, and why
 * the sort controls are addressed by position (each label matches the phone
 * strip, the column header row, and a caption).
 *
 * The report's two chart-view tables are deliberately NOT converted: the plain
 * Date/Value table is a genuinely narrow two-column table, and the per-security
 * breakdown table has a dynamic column count (one column per security) that
 * mechanism A's fixed `grid-cols-N` cannot express. Only the Portfolio
 * Breakdown table below the chart wraps.
 */

const mockGetInvestmentsDaily = vi.fn();
const mockGetInvestmentsSampled = vi.fn();
const mockGetInvestmentsBreakdown = vi.fn();
const mockGetPeriodResult = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetIntradayValue = vi.fn();
const mockGetIntradayBreakdown = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the factory
// because `vi.mock` is hoisted above the const it would close over, and returned
// as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/portfolio-value',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportPdf }: any) => (
    <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatCurrencyFlag: (n: number) => `$${n.toFixed(2)}`,
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    // A long range asks the daily endpoint for its month-end sample.
    getInvestmentsDaily: (...args: any[]) =>
      args[0]?.sampling === 'monthEnd'
        ? mockGetInvestmentsSampled(...args)
        : mockGetInvestmentsDaily(...args),
    getInvestmentsBreakdown: (...args: any[]) => mockGetInvestmentsBreakdown(...args),
    getInvestmentsPeriodResult: (...args: any[]) => mockGetPeriodResult(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getIntradayValue: (...args: any[]) => mockGetIntradayValue(...args),
    getIntradayBreakdown: (...args: any[]) => mockGetIntradayBreakdown(...args),
  },
}));

// Two accounts with distinct totals so a sort reorders them. Default breakdown
// sort is total descending, so Brokerage A (1,500) leads Brokerage B (500).
const HOLDINGS_BY_ACCOUNT = [
  { accountId: 'acc-a', accountName: 'Brokerage A', totalMarketValue: 1000, cashBalance: 500, totalGainLoss: 300 },
  { accountId: 'acc-b', accountName: 'Brokerage B', totalMarketValue: 400, cashBalance: 100, totalGainLoss: -50 },
];

async function renderReport() {
  mockGetInvestmentsSampled.mockResolvedValue([]);
  mockGetInvestmentsDaily.mockResolvedValue([]);
  mockGetInvestmentsBreakdown.mockResolvedValue({ series: [], points: [] });
  mockGetIntradayValue.mockResolvedValue({ points: [], fallbackToDaily: false, skippedSymbols: [] });
  mockGetIntradayBreakdown.mockResolvedValue({ series: [], points: [], fallbackToDaily: false, skippedSymbols: [] });
  mockGetPortfolioSummary.mockResolvedValue({ holdingsByAccount: HOLDINGS_BY_ACCOUNT });
  mockGetInvestmentAccounts.mockResolvedValue([]);

  let container!: HTMLElement;
  await act(async () => {
    container = render(<PortfolioValueReport />).container;
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

const stripGlyph = (el: Element) => el.textContent?.replace(/[↑↓↕]/g, '').trim();

describe('PortfolioValueReport breakdown table (phone wrapped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The KPI cards read the server's period result; this suite is about the
    // breakdown table below them, so a complete one keeps them out of the way.
    mockGetPeriodResult.mockResolvedValue({
      currency: 'CAD',
      startDate: '2024-01-01',
      endDate: '2026-01-01',
      startValue: 0,
      endValue: 0,
      valueChange: 0,
      netExternalFlows: 0,
      knownFlowSubtotal: 0,
      investmentResult: 0,
      returnPercent: 0,
      returnMethod: 'simple',
      complete: true,
      reasons: [],
      missingRatePairs: [],
      unpricedSecurityIds: [],
      unknownCashAccountIds: [],
    });
  });

  it('keeps a table from sm up and a grid below it, with the semantics a restyle strips', async () => {
    const container = await renderReport();

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    for (const group of container.querySelectorAll('thead, tbody')) {
      expect(group.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of container.querySelectorAll('tbody tr')) {
      expect(row.getAttribute('role')).toBe('row');
      expect(row.className).toContain('grid grid-cols-3');
      expect(row.className).toContain('sm:table-row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(container.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    for (const th of container.querySelectorAll('th')) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('places every cell on the phone grid explicitly, headline figure beside its identity', async () => {
    const container = await renderReport();

    // Line 1: account | (empty) | total. Line 2: holdings | cash | gain/loss.
    // DOM order is the desktop column order (account, holdings, cash, total,
    // gainLoss), so placement is read off the classes rather than off position.
    for (const row of container.querySelectorAll('tbody tr')) {
      const [account, holdings, cash, total, gainLoss] = Array.from(row.querySelectorAll('td'));
      expect(placement(account)).toBe('c1/r1');
      expect(placement(holdings)).toBe('c1/r2');
      expect(placement(cash)).toBe('c2/r2');
      expect(placement(total)).toBe('c3/r1');
      expect(placement(gainLoss)).toBe('c3/r2');
      for (const cell of [account, holdings, cash, total, gainLoss]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('captions every bare figure with its column key, and leaves the account self-naming', async () => {
    const container = await renderReport();

    const rowA = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('Brokerage A'),
    )!;
    // Each caption sits beside the value it names, as its own text node, so a
    // value lookup still matches the value node.
    expect(rowA.textContent).toContain('Holdings' + '$1000.00');
    expect(rowA.textContent).toContain('Cash' + '$500.00');
    expect(rowA.textContent).toContain('Total' + '$1500.00');
    expect(rowA.textContent).toContain('Gain/Loss' + '+$300.00');
    // The account is the identity, so it carries no caption span.
    const account = rowA.querySelector('.col-start-1.row-start-1')!;
    expect(account.textContent).toBe('Brokerage A');
    expect(account.querySelector('span')).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Account', 'Holdings', 'Cash', 'Total', 'Gain/Loss']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('never wraps a money figure, and gives each caption whitespace-normal back', async () => {
    const container = await renderReport();

    for (const row of container.querySelectorAll('tbody tr')) {
      // The four figure cells (holdings, cash, total, gain/loss) are
      // right-aligned and never wrap; the account may wrap and is not a figure.
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      expect(figures).toHaveLength(4);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
      // The account cell wraps its name; it is not right-aligned.
      const account = row.querySelector('.col-start-1.row-start-1')!;
      expect(account.className).not.toContain('whitespace-nowrap');
      expect(account.className).toContain('break-words');
    }
  });

  it('restores this table’s own cell padding from sm up, per cell', async () => {
    const container = await renderReport();

    for (const cell of container.querySelectorAll('tbody td')) {
      // No padding of its own below `sm`; the row supplies it. This table's
      // `px-4 py-3` restored from `sm` up.
      expect(cell.className).toContain('p-0');
      expect(cell.className).toContain('sm:px-4');
      expect(cell.className).toContain('sm:py-3');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderReport();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    const labelsOf = (row: Element) => Array.from(row.querySelectorAll('th')).map(stripGlyph);
    const expected = ['Account', 'Holdings', 'Cash', 'Total', 'Gain/Loss'];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different fields.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();

    const accountOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('.col-start-1.row-start-1')?.textContent,
      );
    // Default sort is total descending: Brokerage A (1,500) leads B (500).
    expect(accountOrder()).toEqual(['Brokerage A', 'Brokerage B']);

    // "Total" in the phone strip is the fourth of the five controls in the first
    // header row. Addressed by position because the label also appears in the
    // column header row and in a caption.
    const phoneTotal = container.querySelectorAll('thead tr')[0].querySelectorAll('th')[3];
    await act(async () => {
      fireEvent.click(phoneTotal);
    });
    // Toggling total to ascending puts Brokerage B (500) first.
    expect(accountOrder()).toEqual(['Brokerage B', 'Brokerage A']);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderReport();

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
