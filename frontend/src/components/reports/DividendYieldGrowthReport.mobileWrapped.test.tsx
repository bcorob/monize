import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { DividendYieldGrowthReport } from './DividendYieldGrowthReport';
import type { InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';

/**
 * The phone layout of the Dividend Yield Growth report's per-security yield
 * table (the default "yield" view). It is the one wide table on the report --
 * five columns -- so it is the one that wraps; the year-over-year and frequency
 * views have three columns each and stay ordinary tables.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a three-column, two-line grid and the column header row is replaced by a
 * sort strip, from `sm` up it is the ordinary table. jsdom applies no media
 * queries, so both header rows and every phone caption are in the DOM here at
 * all times -- which is what lets these assertions read the phone markup
 * without emulating a viewport, and why the sort controls are addressed by
 * position rather than by label (each label matches the phone strip, the column
 * header row, and a caption).
 */

const mockGetInvestmentAccounts = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetPortfolioSummary = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the factory
// because `vi.mock` is hoisted above the const it would close over, and
// returned as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/dividend-yield-growth',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatPercent: (n: number, d = 2) => `${n.toFixed(d)}%`,
      formatSignedPercent: (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    // Identity conversion: this report's card layout is the subject, not FX, so
    // every amount converts to itself and both single- and multi-account paths
    // produce the same figures.
    convertToDefault: (value: number) => value,
    convert: (value: number) => value,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({ exportToPdf: vi.fn() }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

// Two securities, one holding each, both priced and paying a dividend within
// the trailing 12 months (today is 2026 in the run environment). AAA yields
// 2.50% (2,500 / 100,000) and BBB 2.00% (1,000 / 50,000), so the default
// yield-descending sort is [AAA, BBB] and a dividends-ascending sort is
// [BBB, AAA] -- distinct orders, so the sort assertion cannot pass by accident.
const HOLDINGS: HoldingWithMarketValue[] = [
  {
    id: 'h-1', accountId: 'a-1', securityId: 's-1', symbol: 'AAA', name: 'Alpha Corp',
    securityType: 'STOCK', currencyCode: 'USD', quantity: 100, averageCost: 900,
    costBasis: 90000, marketValue: 100000,
  } as HoldingWithMarketValue,
  {
    id: 'h-2', accountId: 'a-1', securityId: 's-2', symbol: 'BBB', name: 'Beta Industries Incorporated',
    securityType: 'STOCK', currencyCode: 'USD', quantity: 50, averageCost: 800,
    costBasis: 40000, marketValue: 50000,
  } as HoldingWithMarketValue,
];

const DIVIDENDS: InvestmentTransaction[] = [
  {
    id: 'd-1', accountId: 'a-1', securityId: 's-1', action: 'DIVIDEND',
    transactionDate: '2026-03-15', totalAmount: 2500, amountCurrencyCode: 'USD',
  } as InvestmentTransaction,
  {
    id: 'd-2', accountId: 'a-1', securityId: 's-2', action: 'DIVIDEND',
    transactionDate: '2026-06-15', totalAmount: 1000, amountCurrencyCode: 'USD',
  } as InvestmentTransaction,
];

async function renderTable() {
  mockGetInvestmentAccounts.mockResolvedValue([
    { id: 'a-1', name: 'Brokerage', currencyCode: 'USD' },
  ]);
  mockGetTransactions.mockImplementation((params: { action: string }) =>
    Promise.resolve({
      data: params.action === 'DIVIDEND' ? DIVIDENDS : [],
      pagination: { hasMore: false },
    }),
  );
  mockGetPortfolioSummary.mockResolvedValue({ holdings: HOLDINGS });

  let container!: HTMLElement;
  await act(async () => {
    container = render(<DividendYieldGrowthReport />).container;
  });
  await waitFor(() =>
    expect(
      screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)'),
    ).toBeInTheDocument(),
  );
  // Wait for the rows themselves, not just the card title (static chrome).
  await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: HTMLElement, symbol: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(symbol),
  );

describe('DividendYieldGrowthReport (phone wrapped yield table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderTable();

    const row = findRow(container, 'AAA');
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('12M Dividends$2500.00');
    expect(rowText(row)).toContain('Market Value$100000.00');
    expect(rowText(row)).toContain('Yield2.50%');
    expect(rowText(row)).toContain('FrequencyUnknown');
    // The security is the row's identity, not one of its figures, so it carries
    // no caption -- it names itself with its symbol and name.
    const identity = row?.querySelector('td');
    expect(identity?.querySelector('div')?.textContent).toBe('AAA');
    expect(identity?.querySelector('span')).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Security', '12M Dividends', 'Market Value', 'Yield', 'Frequency']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a number', async () => {
    const container = await renderTable();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The three numeric cells (dividends, market value, yield) never wrap and
      // are right-aligned; the frequency word may wrap and the security is the
      // identity. Right alignment is not containment -- a figure past the
      // measured budget overflows the end edge -- but truncating would be worse.
      const money = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(money).toHaveLength(3);
      for (const cell of money) {
        expect(cell.className).toContain('text-right');
        // `white-space` is inherited, so the caption inside a nowrap cell has to
        // take the ban back or an unbreakable caption would overflow its track.
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });

  it('wraps each row onto two lines of three tracks, headline yield beside the security', async () => {
    const container = await renderTable();

    // DOM order is the desktop column order (security, dividends, market value,
    // yield, frequency), so placement is read off the classes, not off
    // position. Line 1: security (spanning two tracks) | yield. Line 2:
    // dividends | market value | frequency.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [security, dividends, marketValue, yieldCell, frequency] = Array.from(
        row.querySelectorAll('td'),
      );
      expect(row.className).toContain('grid-cols-3');
      expect(placement(security)).toBe('c1/r1/s2');
      expect(placement(yieldCell)).toBe('c3/r1/s1');
      expect(placement(dividends)).toBe('c1/r2/s1');
      expect(placement(marketValue)).toBe('c2/r2/s1');
      expect(placement(frequency)).toBe('c3/r2/s1');
      // Nothing is placed on a third line.
      for (const cell of [security, dividends, marketValue, yieldCell, frequency]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderTable();

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-3');
    expect(row?.className).toContain('sm:table-row');
    // The row keeps the hover treatment it draws today, on both layouts.
    expect(row?.className).toContain('hover:bg-gray-50');
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores this table’s own cell padding from sm up', async () => {
    const container = await renderTable();

    // Below `sm` the figure cells carry no padding of their own -- the row
    // supplies it; from `sm` up each restores this table's `px-4 py-3`.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [security, dividends, marketValue, yieldCell, frequency] = Array.from(
        row.querySelectorAll('td'),
      );
      for (const cell of [security, dividends, marketValue, yieldCell, frequency]) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:px-4');
        expect(cell.className).toContain('sm:py-3');
      }
    }
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderTable();

    const table = container.querySelector('table');
    expect(table?.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(container.querySelectorAll('tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(container.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so both
    // header rows already carry it.
    for (const th of Array.from(container.querySelectorAll('th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderTable();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    // The sort indicator glyph rides inside each control, so compare the labels
    // with it stripped.
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) =>
        th.textContent?.replace(/[↑↓↕]/g, '').trim(),
      );
    const expected = ['Security', '12M Dividends', 'Market Value', 'Yield', 'Frequency'];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderTable();

    const symbolOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td div')?.textContent,
      );
    // Default sort is yield descending: AAA (2.50%) before BBB (2.00%).
    expect(symbolOrder()).toEqual(['AAA', 'BBB']);

    // "12M Dividends" in the phone strip: the second of the five controls in
    // the first header row. Addressed by position because the label also
    // appears in the column header row and in every caption.
    const phoneDividends = container
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[1];
    await act(async () => {
      fireEvent.click(phoneDividends);
    });
    // Ascending by dividends puts BBB's $1,000 before AAA's $2,500.
    expect(symbolOrder()).toEqual(['BBB', 'AAA']);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderTable();

    // These rows have never been clickable, and wrapping them must not make them
    // so. Clicking is the live half of the assertion: React attaches handlers
    // synthetically and never writes an `onclick` attribute, so an added
    // `onClick` is invisible to a markup check.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
