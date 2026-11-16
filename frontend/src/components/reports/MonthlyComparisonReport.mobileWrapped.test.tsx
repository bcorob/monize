import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { MonthlyComparisonReport } from './MonthlyComparisonReport';

/**
 * The phone layout of the Monthly Comparison report's two wide tables (the
 * monthly expense comparison and the investment Top Movers).
 *
 * Both are ONE tree restyled by CSS (mechanism A): below `sm` each row wraps into
 * a three-column grid card and the column header row is replaced by a sort strip,
 * from `sm` up each is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which is
 * what lets these assertions read the phone markup without emulating a viewport,
 * and why the sort controls are addressed by position (each label also appears in
 * the column header row, and often in a caption or the month picker).
 */

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatPercent: (n: number, decimals = 2) => `${n.toFixed(decimals)}%`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f97316'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => <div>{children}</div>,
  Bar: ({ children }: any) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const mockGetMonthlyComparison = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getMonthlyComparison: (...args: any[]) => mockGetMonthlyComparison(...args),
  },
}));

// Two comparison rows and two top movers, so a sort reorders something visible.
// Default sorts are current-total descending (comparison) and change-percent
// descending (movers), so Groceries and AAPL lead their tables.
const mockResponse = {
  currentMonth: '2026-01',
  previousMonth: '2025-12',
  currentMonthLabel: 'January 2026',
  previousMonthLabel: 'December 2025',
  currency: 'CAD',
  incomeExpenses: {
    currentMonth: '2026-01',
    previousMonth: '2025-12',
    currentIncome: 5000,
    previousIncome: 4500,
    incomeChange: 500,
    incomeChangePercent: 11.11,
    currentExpenses: 3000,
    previousExpenses: 3500,
    expensesChange: -500,
    expensesChangePercent: -14.29,
    currentSavings: 2000,
    previousSavings: 1000,
    savingsChange: 1000,
    savingsChangePercent: 100,
  },
  notes: { savingsNote: 'saved more', incomeNote: 'income up' },
  expenses: {
    currentMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 800 },
    ],
    previousMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 700 },
    ],
    comparison: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', currentTotal: 800, previousTotal: 700, change: 100, changePercent: 14.29 },
      { categoryId: 'cat-2', categoryName: 'Utilities', color: '#00ff00', currentTotal: 400, previousTotal: 0, change: 400, changePercent: 100 },
    ],
    currentTotal: 1200,
    previousTotal: 700,
  },
  topCategories: { currentMonth: [], previousMonth: [] },
  netWorth: {
    monthlyHistory: [{ month: '2026-01', netWorth: 52000 }],
    currentNetWorth: 52000,
    previousNetWorth: 50000,
    netWorthChange: 2000,
    netWorthChangePercent: 4,
  },
  investments: {
    accountPerformance: [],
    topMovers: [
      { securityId: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', currentPrice: 195.5, previousPrice: 190, change: 5.5, changePercent: 2.89, marketValue: 19550 },
      { securityId: 'sec-2', symbol: 'MSFT', name: 'Microsoft Corp.', currentPrice: 410, previousPrice: 415, change: -5, changePercent: -1.2, marketValue: 41000 },
    ],
  },
};

async function renderReport() {
  mockGetMonthlyComparison.mockResolvedValue(mockResponse);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<MonthlyComparisonReport />).container;
  });
  await waitFor(() => expect(container.querySelectorAll('table').length).toBeGreaterThanOrEqual(2));
  return container;
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

const stripGlyph = (el: Element) => el.textContent?.replace(/[↑↓↕]/g, '').trim();

// table[0] is the expense comparison; table[1] is Top Movers (a later section).
const comparisonTable = (c: HTMLElement) => c.querySelectorAll('table')[0];
const topMoversTable = (c: HTMLElement) => c.querySelectorAll('table')[1];

describe('MonthlyComparisonReport comparison table (phone wrapped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a table from sm up and a grid below it, with the semantics a restyle strips', async () => {
    const container = await renderReport();
    const table = comparisonTable(container);

    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(table.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(table.querySelector('tbody')?.className).toContain('sm:table-row-group');
    for (const group of table.querySelectorAll('thead, tbody')) {
      expect(group.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.getAttribute('role')).toBe('row');
      expect(row.className).toContain('grid grid-cols-3');
      expect(row.className).toContain('sm:table-row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(table.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    for (const th of table.querySelectorAll('th')) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('places every cell on the phone grid explicitly, derived figure under its month', async () => {
    const container = await renderReport();
    // DOM order is the desktop column order (category, current, previous, change,
    // change %); placement is read off the classes, not off position. Line 1:
    // category | current | previous. Line 2: change (under current) | change %
    // (under previous).
    for (const row of topOf(comparisonTable(container))) {
      const [category, current, previous, change, changePercent] = Array.from(row.querySelectorAll('td'));
      expect(placement(category)).toBe('c1/r1');
      expect(placement(current)).toBe('c2/r1');
      expect(placement(previous)).toBe('c3/r1');
      expect(placement(change)).toBe('c2/r2');
      expect(placement(changePercent)).toBe('c3/r2');
      for (const cell of [category, current, previous, change, changePercent]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('captions every bare figure with its column key, and leaves the category self-naming', async () => {
    const container = await renderReport();
    const row = Array.from(comparisonTable(container).querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('Groceries'),
    )!;

    // The two month columns caption with the same locale-aware month labels the
    // column header shows; change and change % with the existing header keys.
    expect(row.querySelector('.col-start-2.row-start-1')?.textContent).toBe('January 2026$800.00');
    expect(row.querySelector('.col-start-3.row-start-1')?.textContent).toBe('December 2025$700.00');
    expect(row.querySelector('.col-start-2.row-start-2')?.textContent).toBe('Change+$100.00');
    expect(row.querySelector('.col-start-3.row-start-2')?.textContent).toBe('Change %+14.3%');

    // Category is the identity: no caption, just the name (its colour dot is the
    // only span besides the name wrapper).
    const category = row.querySelector('.col-start-1.row-start-1')!;
    expect(category.textContent).toBe('Groceries');
    // The captions reuse the table's own column labels: no new catalogue string.
    for (const caption of ['Change', 'Change %']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('never wraps a money or percentage figure, and gives each caption whitespace-normal back', async () => {
    const container = await renderReport();
    for (const row of topOf(comparisonTable(container))) {
      // The four figure cells (current, previous, change, change %) never wrap.
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      expect(figures).toHaveLength(4);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
      // The category wraps unclamped and is not right-aligned.
      const category = row.querySelector('.col-start-1.row-start-1')!;
      expect(category.className).not.toContain('whitespace-nowrap');
      expect(category.querySelector('.break-words')).not.toBeNull();
    }
  });

  it('restores this table’s own cell padding from sm up, per figure cell', async () => {
    const container = await renderReport();
    for (const cell of comparisonTable(container).querySelectorAll('tbody td')) {
      // No padding of its own below `sm`; the row supplies it. This table's
      // `px-4 py-3` restored from `sm` up.
      expect(cell.className).toContain('p-0');
      expect(cell.className).toContain('sm:px-4');
      expect(cell.className).toContain('sm:py-3');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderReport();
    const headerRows = Array.from(comparisonTable(container).querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');
    const labelsOf = (r: Element) => Array.from(r.querySelectorAll('th')).map(stripGlyph);
    expect(labelsOf(phoneRow)).toEqual(['Category', 'January 2026', 'December 2025', 'Change', 'Change %']);
    // Both rows are rendered from one list, so they cannot list different fields.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();
    const order = () =>
      Array.from(comparisonTable(container).querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('.col-start-1.row-start-1')?.textContent,
      );
    // Default sort is current-total descending: Groceries (800) leads Utilities (400).
    expect(order()).toEqual(['Groceries', 'Utilities']);

    // "December 2025" (previous) is the third of the five controls in the phone
    // strip. Clicking a new field sorts ascending: Utilities (0) leads Groceries (700).
    const phonePrevious = comparisonTable(container).querySelectorAll('thead tr')[0].querySelectorAll('th')[2];
    await act(async () => {
      fireEvent.click(phonePrevious);
    });
    expect(order()).toEqual(['Utilities', 'Groceries']);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderReport();
    const rows = Array.from(comparisonTable(container).querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
    }
  });
});

describe('MonthlyComparisonReport top movers table (phone wrapped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps each mover onto a three-column grid, change beside the symbol', async () => {
    const container = await renderReport();
    const table = topMoversTable(container);
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');

    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.className).toContain('grid grid-cols-3');
      expect(row.className).toContain('sm:table-row');
      // DOM order is the desktop column order: symbol, name, price, change, change %.
      const [symbol, name, price, change, changePercent] = Array.from(row.querySelectorAll('td'));
      expect(placement(symbol)).toBe('c1/r1');
      expect(placement(name)).toBe('c1/r2');
      expect(placement(price)).toBe('c2/r2');
      expect(placement(change)).toBe('c2/r1');
      expect(placement(changePercent)).toBe('c3/r1');
      for (const cell of [symbol, name, price, change, changePercent]) {
        expect(cell.getAttribute('role')).toBe('cell');
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
    }
  });

  it('captions the figures, and leaves the symbol and its name descriptor self-naming', async () => {
    const container = await renderReport();
    const row = Array.from(topMoversTable(container).querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('AAPL'),
    )!;

    // Symbol is the identity and the name is a descriptor sitting under it, so
    // neither carries a caption.
    expect(row.querySelector('.col-start-1.row-start-1')?.textContent).toBe('AAPL');
    expect(row.querySelector('.col-start-1.row-start-2')?.textContent).toBe('Apple Inc.');
    expect(row.querySelector('.col-start-1.row-start-1')?.querySelector('span')).toBeNull();
    expect(row.querySelector('.col-start-1.row-start-2')?.querySelector('span')).toBeNull();

    // The three figures each caption with an existing column key.
    expect(row.querySelector('.col-start-2.row-start-1')?.textContent).toBe('Change+$5.50');
    expect(row.querySelector('.col-start-3.row-start-1')?.textContent).toBe('Change %+2.89%');
    expect(row.querySelector('.col-start-2.row-start-2')?.textContent).toBe('Price$195.50');

    // Each figure never wraps and its caption takes whitespace-normal back.
    for (const sel of ['.col-start-2.row-start-1', '.col-start-3.row-start-1', '.col-start-2.row-start-2']) {
      const cell = row.querySelector(sel)!;
      expect(cell.className).toContain('whitespace-nowrap');
      expect(cell.className).toContain('text-right');
      expect(cell.querySelector('span')?.className).toContain('whitespace-normal');
      expect(cell.querySelector('span')?.className).toContain('sm:hidden');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderReport();
    const headerRows = Array.from(topMoversTable(container).querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');
    const labelsOf = (r: Element) => Array.from(r.querySelectorAll('th')).map(stripGlyph);
    expect(labelsOf(phoneRow)).toEqual(['Symbol', 'Name', 'Price', 'Change', 'Change %']);
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();
    const order = () =>
      Array.from(topMoversTable(container).querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('.col-start-1.row-start-1')?.textContent,
      );
    // Default sort is change-percent descending: AAPL (+2.89%) leads MSFT (-1.2%).
    expect(order()).toEqual(['AAPL', 'MSFT']);

    // "Change" is the fourth of the five controls in the phone strip; a new field
    // sorts ascending: MSFT (-5) leads AAPL (+5.5).
    const phoneChange = topMoversTable(container).querySelectorAll('thead tr')[0].querySelectorAll('th')[3];
    await act(async () => {
      fireEvent.click(phoneChange);
    });
    expect(order()).toEqual(['MSFT', 'AAPL']);
  });
});

/** The `<tr>` rows of a wrapped table's body. */
function topOf(table: Element) {
  return Array.from(table.querySelectorAll('tbody tr'));
}
