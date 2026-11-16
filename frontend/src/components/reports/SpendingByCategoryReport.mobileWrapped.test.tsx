import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SpendingByCategoryReport } from './SpendingByCategoryReport';
import type { SpendingByCategoryResponse } from '@/types/built-in-reports';

/**
 * The phone layout of the Spending by Category data table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` each row wraps
 * into a two-track, two-line grid card and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which
 * is what lets these assertions read the phone markup without emulating a
 * viewport, and why the sort controls are addressed by position rather than by
 * label (each label matches the phone strip, the column header row, and a
 * caption).
 *
 * This report defaults to the pie view, so every case switches to the table
 * view first (the table only mounts there).
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Spread the shared defaults so a new formatter call in the component cannot
// crash this suite; the compact currency formatter (0dp, grouped) is what the
// table's amount cells really use.
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults() }),
  };
});

let mockIsValid = true;
vi.mock('@/hooks/useDateRange', () => {
  const resolvedRange = { start: '2025-01-01', end: '2025-03-31' };
  return {
    useDateRange: () => ({
      dateRange: '3m',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange,
      get isValid() {
        return mockIsValid;
      },
    }),
  };
});

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f97316'],
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/ui/ChartViewToggle', () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-table" onClick={() => onChange('table')}>Table</button>
    </div>
  ),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

const mockGetSpendingByCategory = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) => mockGetSpendingByCategory(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Value order and name order differ (Zebra/Apple/Mango), so a sort click that
// changes the visible order is observable. Mango carries no id, so its row is
// the non-clickable case.
const DATA = [
  { categoryId: 'c-zebra', categoryName: 'Zebra', total: 500, color: '#ff0000' },
  { categoryId: 'c-apple', categoryName: 'Apple', total: 300, color: '' },
  { categoryId: '', categoryName: 'Mango', total: 200, color: '' },
];

async function renderReport() {
  mockGetSpendingByCategory.mockResolvedValue(completeReport(DATA, 1000));
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<SpendingByCategoryReport />));
  });
  await waitFor(() => expect(screen.getByTestId('toggle-table')).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByTestId('toggle-table'));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: Element, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.querySelector('td')?.textContent?.includes(name),
  );

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};

/**
 * A report answer with nothing left out: `knownSpending` equals the total and
 * no currency was dropped, so every figure is complete.
 */
function completeReport(
  data: SpendingByCategoryResponse['data'],
  totalSpending: number,
): SpendingByCategoryResponse {
  return {
    data,
    totalSpending,
    knownSpending: totalSpending,
    currency: 'CAD',
    missingCurrencies: [],
    excludedCount: 0,
  };
}

// The account filter and the tag controls read these on mount; the report is
// the unchanged one while no key is chosen.
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
}));

describe('SpendingByCategoryReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
    window.localStorage.clear();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findRow(container, 'Zebra');
    expect(row).toBeDefined();
    for (const caption of ['Amount', '% of Total']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a value read still matches the value node.
    expect(rowText(row)).toContain('Amount$500');
    expect(rowText(row)).toContain('% of Total50.0%');
    // The identity (the category name) is self-describing and carries no caption.
    const identity = row!.querySelector('td')!;
    expect(identity.textContent).toBe('Zebra');
    expect(rowText(identity)).not.toContain('Category');
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderReport();

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(3);
      for (const cell of cells) {
        // Auto-flow placement is not deterministic, so each cell states its own
        // column and line.
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The two figure cells (amount and share) never wrap and are right
      // aligned; the identity cell is neither.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(2);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto two lines: the category, then the amount and the share', async () => {
    const container = await renderReport();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [category, amount, share] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
      // The category takes the whole of line 1, the amount and the share split
      // line 2 beneath it.
      expect(category.className).toContain('col-span-2');
      expect(placement(category)).toBe('c1/r1');
      expect(placement(amount)).toBe('c1/r2');
      expect(placement(share)).toBe('c2/r2');
      // Nothing is placed on a third line.
      for (const cell of [category, amount, share]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('gives the totals row the data row placement, every cell captioned', async () => {
    const container = await renderReport();

    const footRow = container.querySelector('tfoot tr')!;
    expect(footRow.className).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
    const [total, amount, share] = Array.from(footRow.querySelectorAll('td'));
    expect(total.textContent).toBe('Total');
    expect(placement(total)).toBe('c1/r1');
    expect(placement(amount)).toBe('c1/r2');
    expect(placement(share)).toBe('c2/r2');

    // Every column has a total, so no footer cell leaves the DOM and none owes
    // an `aria-colindex`.
    for (const cell of Array.from(footRow.querySelectorAll('td'))) {
      expect(cell.getAttribute('aria-colindex')).toBeNull();
    }

    // The totals are the largest figures on the table and carry their captions
    // like any other cell, so a phone reader is not left with two bare numbers.
    for (const cell of [amount, share]) {
      expect(cell.className).toContain('font-bold');
      expect(cell.className).toContain('whitespace-nowrap');
    }
    expect(footRow.textContent).toContain('Amount$1,000');
    expect(footRow.textContent).toContain('% of Total100%');
  });

  it('keeps the identity a colour dot beside an unclamped, uncaptioned name', async () => {
    const container = await renderReport();

    const identity = findRow(container, 'Zebra')!.querySelector('td')!;
    const inner = identity.querySelector('div')!;
    expect(inner.className).toBe('flex items-center gap-2');
    // A category name is unbounded, so it wraps rather than clamps or truncates.
    const name = inner.querySelector('span')!;
    expect(name.className).toContain('break-words');
    expect(name.className).toContain('sm:break-normal');
    expect(identity.className).not.toContain('line-clamp');
    expect(identity.className).not.toContain('truncate');
    expect(identity.textContent).toBe('Zebra');
    expect(inner.querySelector('div')!.className).toContain('rounded-full');
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderReport();

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    expect(container.querySelector('tfoot')?.className).toContain('sm:table-footer-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
    expect(row?.className).toContain('sm:table-row');
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderReport();

    const table = container.querySelector('table');
    expect(table?.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody', 'tfoot']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(container.querySelectorAll('table tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // Three data rows of three cells plus a three-cell footer.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(12);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so both
    // header rows carry it.
    for (const th of Array.from(container.querySelectorAll('table th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same three sort controls on phones as in the column header', async () => {
    const container = await renderReport();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) =>
        th.textContent?.replace(/[↑↓↕]/g, '').trim(),
      );
    expect(labelsOf(phoneRow)).toEqual(['Category', 'Amount', '% of Total']);
    // Both rows are rendered from one list, so they cannot list different fields.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // No column is stranded without a control: every header row carries exactly
    // as many controls as a data row has cells.
    const cellsPerRow =
      container.querySelectorAll('tbody tr td').length /
      container.querySelectorAll('tbody tr').length;
    expect(phoneRow.querySelectorAll('th')).toHaveLength(cellsPerRow);
    expect(columnRow.querySelectorAll('th')).toHaveLength(cellsPerRow);
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();

    const nameOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    // The stored default is the amount, descending.
    expect(nameOrder()).toEqual(['Zebra', 'Apple', 'Mango']);

    // "Category" in the PHONE strip -- identified by the class that hides it
    // from `sm` up, so this cannot silently fall through to the column header.
    // Within it the control is the first of three, addressed by position because
    // the label also appears in the column header and every caption.
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    );
    expect(phoneStrip).toBeDefined();
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(nameOrder()).toEqual(['Apple', 'Mango', 'Zebra']);

    // A second tap reverses it.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(nameOrder()).toEqual(['Zebra', 'Mango', 'Apple']);
  });

  it('keeps the row clickable, as it is today', async () => {
    const container = await renderReport();

    // A row that names a category navigates to its transactions.
    const zebra = findRow(container, 'Zebra')!;
    expect(zebra.className).toContain('cursor-pointer');
    await act(async () => {
      fireEvent.click(zebra);
    });
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=c-zebra&startDate=2025-01-01&endDate=2025-03-31',
    );

    // A row with no category id is inert and carries no pointer cue.
    mockPush.mockClear();
    const mango = findRow(container, 'Mango')!;
    expect(mango.className).not.toContain('cursor-pointer');
    await act(async () => {
      fireEvent.click(mango);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('leaves the controls outside the table alone', async () => {
    await renderReport();

    expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
    expect(screen.getByTestId('chart-view-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('export-dropdown')).toBeInTheDocument();
  });
});
