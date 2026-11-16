import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { GeographicAllocationReport } from './GeographicAllocationReport';

/**
 * The phone layout of the Geographic Allocation report's three data tables.
 *
 * Each table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a grid card and the column header row is hidden, from `sm` up it is the
 * ordinary table. jsdom applies no media queries, so both header rows and every
 * phone caption are in the DOM here at all times -- which is what lets these
 * assertions read the phone markup without emulating a viewport, and why the
 * sort controls are addressed by position rather than by label (each label
 * matches the phone strip, the column header row and a caption).
 *
 * The report has three views reached by the toggle -- Region (4 columns),
 * Exchange (5 columns) and Country (3 columns) -- and the claim these tests hold
 * is that all three wrap without a horizontal scroll, keep their `sm`+ output,
 * and strand no column with no way to sort by it on a phone.
 */

const mockPush = vi.fn();
// One router for the run, as `src/test/setup.ts` builds it: `useRouter()` returns
// the same object every render in the real hook, so a factory handing back a
// fresh one changes the identity of every `useCallback([router])` and an effect
// that also sets state loops. Built lazily inside the factory because `vi.mock`
// is hoisted above the `const` it closes over.
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

// The 2dp `formatCurrency` this table's cells really use -- it is what makes a
// six-figure amount too wide for the money column on a phone. Spread the shared
// defaults first so a formatter the component happens to call is never missing.
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

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    // Identity conversion so a holding's market value survives to the table.
    convertToDefault: (amount: number) => amount,
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

// Two North American exchanges, one European and one Asia-Pacific, with market
// values chosen so every percentage is a round number and the sort order is
// unambiguous. `convertToDefault` is the identity above, so the market value is
// the holding's own.
const HOLDINGS = [
  { securityId: 's-nasdaq', currencyCode: 'USD', quantity: 1, marketValue: 2000 },
  { securityId: 's-tsx', currencyCode: 'CAD', quantity: 1, marketValue: 3000 },
  { securityId: 's-lse', currencyCode: 'GBP', quantity: 1, marketValue: 1000 },
  { securityId: 's-tyo', currencyCode: 'JPY', quantity: 1, marketValue: 4000 },
];

const SECURITIES = [
  { id: 's-nasdaq', symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', isActive: true },
  { id: 's-tsx', symbol: 'RY.TO', name: 'Royal Bank of Canada', exchange: 'TSX', isActive: true },
  { id: 's-lse', symbol: 'BP.L', name: 'BP plc', exchange: 'LSE', isActive: true },
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

async function renderReport() {
  mockGetPortfolioSummary.mockResolvedValue({ holdings: HOLDINGS });
  mockGetInvestmentAccounts.mockResolvedValue([]);
  mockGetSecurities.mockResolvedValue(SECURITIES);
  mockGetCountryWeightings.mockResolvedValue(COUNTRY_WEIGHTINGS);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<GeographicAllocationReport />));
  });
  // The region view is the default; wait for its table to mount.
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

async function switchView(name: 'By Exchange' | 'By Country') {
  await act(async () => {
    fireEvent.click(screen.getByText(name));
  });
}

const cellsOf = (row: Element) => Array.from(row.querySelectorAll('td'));

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};
const placements = (row: Element) => cellsOf(row).map(placement);

/** The phone sort strip: the header row hidden from `sm` up, not the column row. */
const phoneStrip = (container: Element) =>
  Array.from(container.querySelectorAll('thead tr')).find((r) =>
    r.className.includes('sm:hidden'),
  )!;

const bodyRows = (container: Element) =>
  Array.from(container.querySelectorAll('tbody tr'));

const regionOrder = (container: Element) =>
  bodyRows(container).map((r) => r.querySelector('td')?.querySelector('span')?.textContent);

describe('GeographicAllocationReport (phone wrapped tables)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    window.localStorage.clear();
  });

  it('makes each table a block below sm and a table from sm up, on every view', async () => {
    const container = await renderReport();
    for (const view of [null, 'By Exchange', 'By Country'] as const) {
      if (view) await switchView(view);
      const table = container.querySelector('table')!;
      expect(table.className).toContain('block');
      expect(table.className).toContain('sm:table');
      expect(container.querySelector('thead')!.className).toContain('sm:table-header-group');
      expect(container.querySelector('tbody')!.className).toContain('sm:table-row-group');
      expect(container.querySelector('tfoot')!.className).toContain('sm:table-footer-group');
      // The wrapper still scrolls horizontally, which is what a narrow desktop
      // window needs from `sm` up.
      expect(table.parentElement!.className).toContain('overflow-x-auto');
      const row = container.querySelector('tbody tr')!;
      expect(row.className).toContain('grid grid-cols-2');
      expect(row.className).toContain('sm:table-row');
    }
  });

  it('restores the table semantics a phone restyle strips, on every view', async () => {
    const container = await renderReport();
    for (const view of [null, 'By Exchange', 'By Country'] as const) {
      if (view) await switchView(view);
      const table = container.querySelector('table')!;
      expect(table.getAttribute('role')).toBe('table');
      for (const group of ['thead', 'tbody', 'tfoot']) {
        expect(container.querySelector(group)!.getAttribute('role')).toBe('rowgroup');
      }
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        expect(row.getAttribute('role')).toBe('row');
      }
      // EVERY `<td>` -- a cell whose className is a template literal is exactly
      // where `role="cell"` gets forgotten -- and the footer's empty spacer too.
      for (const cell of Array.from(table.querySelectorAll('td'))) {
        expect(cell.getAttribute('role')).toBe('cell');
      }
      for (const th of Array.from(table.querySelectorAll('th'))) {
        expect(th.getAttribute('role')).toBe('columnheader');
      }
    }
  });

  it('places every cell explicitly and never wraps a figure, on every view', async () => {
    const container = await renderReport();
    for (const view of [null, 'By Exchange', 'By Country'] as const) {
      if (view) await switchView(view);
      const rows = [...bodyRows(container), container.querySelector('tfoot tr')!];
      for (const row of rows) {
        for (const cell of cellsOf(row)) {
          expect(cell.className).toMatch(/\bcol-start-\d\b/);
          expect(cell.className).toMatch(/\brow-start-\d\b/);
        }
        // Money and the count never wrap and stay right-aligned: right alignment
        // is not containment, but truncating a money value would be worse.
        for (const cell of cellsOf(row).filter((c) => c.className.includes('whitespace-nowrap'))) {
          expect(cell.className).toContain('text-right');
        }
      }
    }
  });

  it('keeps every figure cell identical from sm up', async () => {
    const container = await renderReport();
    // Every original cell was `text-sm px-4 py-3`, so the wrapped figure cell
    // must resolve to exactly that at 640px+ (and never silently to `text-base`
    // or a dropped padding). Below `sm` it is the phone-only `text-xs`.
    for (const view of [null, 'By Exchange', 'By Country'] as const) {
      if (view) await switchView(view);
      const figures = cellsOf(container.querySelector('tbody tr')!).filter((c) =>
        c.className.includes('whitespace-nowrap'),
      );
      expect(figures.length).toBeGreaterThan(0);
      for (const cell of figures) {
        expect(cell.className).toContain('sm:px-4');
        expect(cell.className).toContain('sm:py-3');
        expect(cell.className).toContain('sm:text-sm');
        expect(cell.className).toContain('text-xs');
        expect(cell.className).not.toContain('sm:text-base');
      }
      // The identity cell keeps `text-sm` at every width (a name is prose) and
      // carries the desktop padding from `sm` up.
      const identity = cellsOf(container.querySelector('tbody tr')!)[0];
      expect(identity.className).toContain('min-w-0');
      expect(identity.className).toContain('text-sm');
      expect(identity.className).toContain('sm:px-4');
      const name = identity.querySelector('span')!;
      expect(name.getAttribute('title')).toBe(name.textContent);
      if (view === 'By Country') {
        // The country identity spans the whole line, so it wraps UNCLAMPED --
        // `break-words` on the cell contains an unbreakable token in a full-width
        // track, no clamp needed (and `sm:break-normal` gives today's wrap back).
        expect(identity.className).toContain('break-words');
        expect(identity.className).toContain('sm:break-normal');
        expect(name.className).not.toContain('line-clamp');
      } else {
        // Region/exchange identities share their line with the market value, so
        // the span clamps: the clamp's `overflow: hidden` is what contains an
        // unbreakable token in the narrow track, handed back at `sm`.
        expect(name.className).toContain('line-clamp-3');
        expect(name.className).toContain('break-words');
        expect(name.className).toContain('sm:line-clamp-none');
        expect(name.className).toContain('sm:break-normal');
      }
    }
  });

  it('wraps the region table into two-line cards with all four columns', async () => {
    const container = await renderReport();
    // Region view is the default. Every row has four cells, laid out region +
    // market value on line 1, share + holdings on line 2.
    const rows = [...bodyRows(container), container.querySelector('tfoot tr')!];
    for (const row of rows) {
      const cells = cellsOf(row);
      expect(cells).toHaveLength(4);
      // DOM order is the desktop column order: region, count, market value, share.
      expect(placements(row)).toEqual(['c1/r1', 'c2/r2', 'c2/r1', 'c1/r2']);
      // Every footer column has a total, so nothing hides below `sm` and no cell
      // owes an `aria-colindex`.
      for (const cell of cells) {
        expect(cell.className).not.toMatch(/\bhidden\b/);
        expect(cell.getAttribute('aria-colindex')).toBeNull();
      }
    }
    // Each bare figure names its own column, and the value node is still findable.
    const naRow = bodyRows(container).find((r) => r.textContent?.includes('North America'))!;
    expect(naRow.textContent).toContain('Holdings2');
    expect(naRow.textContent).toContain('Market Value$5000.00');
    expect(naRow.textContent).toContain('% of Portfolio50.0%');
  });

  it('offers the same four sort controls on the region phone strip as in the header', async () => {
    const container = await renderReport();
    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [strip, columnRow] = headerRows;
    expect(strip.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) =>
        th.textContent?.replace(/[↑↓↕]/g, '').trim(),
      );
    expect(labelsOf(strip)).toEqual(['Region', 'Holdings', 'Market Value', '% of Portfolio']);
    expect(labelsOf(columnRow)).toEqual(labelsOf(strip));
    // No column stranded without a control: a header row carries as many controls
    // as a data row has cells.
    const perRow =
      container.querySelectorAll('tbody tr td').length / bodyRows(container).length;
    expect(strip.querySelectorAll('th')).toHaveLength(perRow);
  });

  it('sorts the region table from the phone strip, not only from the column header', async () => {
    const container = await renderReport();
    // Default is market value descending: North America, Asia-Pacific, Europe.
    expect(regionOrder(container)).toEqual(['North America', 'Asia-Pacific', 'Europe']);
    // The first strip control is Region; a new field sorts ascending.
    await act(async () => {
      fireEvent.click(phoneStrip(container).querySelectorAll('th')[0]);
    });
    expect(regionOrder(container)).toEqual(['Asia-Pacific', 'Europe', 'North America']);
    // A second tap reverses it -- the escape from any sort a phone can reach.
    await act(async () => {
      fireEvent.click(phoneStrip(container).querySelectorAll('th')[0]);
    });
    expect(regionOrder(container)).toEqual(['North America', 'Europe', 'Asia-Pacific']);
  });

  it('wraps the exchange table into three-line cards, country as a descriptor', async () => {
    const container = await renderReport();
    await switchView('By Exchange');
    await waitFor(() => expect(screen.getByText('NASDAQ')).toBeInTheDocument());

    const rows = [...bodyRows(container), container.querySelector('tfoot tr')!];
    for (const row of rows) {
      const cells = cellsOf(row);
      expect(cells).toHaveLength(5);
      // DOM order: exchange, country, count, market value, share. The country
      // sits under the exchange identity (c1/r2); the count drops to line 3.
      expect(placements(row)).toEqual(['c1/r1', 'c1/r2', 'c2/r3', 'c2/r1', 'c2/r2']);
    }
    const nasdaqRow = bodyRows(container).find((r) => r.textContent?.includes('NASDAQ'))!;
    // The country is a descriptor under the identity, so it carries NO caption.
    const countryCell = cellsOf(nasdaqRow)[1];
    expect(countryCell.textContent).toBe('United States');
    expect(countryCell.querySelector('span.sm\\:hidden')).toBeNull();
    // The three figure cells each name their own column.
    expect(nasdaqRow.textContent).toContain('Holdings1');
    expect(nasdaqRow.textContent).toContain('Market Value$2000.00');
    expect(nasdaqRow.textContent).toContain('% of Portfolio20.0%');
    // The footer's country column has no total: an empty, captionless spacer that
    // is never hidden below `sm`, so it owes no `aria-colindex`.
    const footCountry = cellsOf(container.querySelector('tfoot tr')!)[1];
    expect(footCountry.textContent).toBe('');
    expect(footCountry.getAttribute('role')).toBe('cell');
    expect(footCountry.getAttribute('aria-colindex')).toBeNull();
  });

  it('wraps the country table into two-line cards with the identity on line 1', async () => {
    const container = await renderReport();
    await switchView('By Country');
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());

    const rows = [...bodyRows(container), container.querySelector('tfoot tr')!];
    for (const row of rows) {
      const cells = cellsOf(row);
      expect(cells).toHaveLength(3);
      // The unbounded identity takes the whole of line 1; the two figures share
      // line 2.
      expect(placements(row)).toEqual(['c1/r1', 'c1/r2', 'c2/r2']);
      expect(cellsOf(row)[0].className).toMatch(/\bcol-span-2\b/);
    }
    const usRow = bodyRows(container).find((r) => r.textContent?.includes('United States'))!;
    expect(usRow.textContent).toContain('Market Value$6000.00');
    expect(usRow.textContent).toContain('% of Portfolio60.0%');
    // The "Other" look-through remainder is still surfaced.
    expect(bodyRows(container).some((r) => r.textContent?.includes('Other'))).toBe(true);
    // The footer totals are captioned like any other cell.
    const foot = container.querySelector('tfoot tr')!;
    expect(foot.textContent).toContain('Total');
    expect(foot.textContent).toContain('Market Value$10000.00');
    expect(foot.textContent).toContain('% of Portfolio100%');
  });

  it('leaves the surfaces outside the tables alone', async () => {
    await renderReport();
    // Filters, summary cards and the region pie chart are not part of the
    // conversion; a phone still gets all of them.
    expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Regions')).toBeInTheDocument();
    expect(screen.getByText('Exchanges')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });
});
