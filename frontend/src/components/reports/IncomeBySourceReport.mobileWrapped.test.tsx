import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { IncomeBySourceReport } from './IncomeBySourceReport';

/**
 * The phone layout of the Income by Source data table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, two-line grid and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which
 * is exactly what lets these assertions read the phone markup without emulating
 * a viewport, and why the sort controls have to be addressed by position rather
 * than by label (each label matches the phone strip, the column header row, and
 * a caption).
 *
 * The report opens on its pie view, so each case switches to the Table view
 * first -- the table is only mounted there.
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reports/income-by-source',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ reportId: 'income-by-source' }),
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
      formatPercent: (n: number, d: number) => `${n.toFixed(d)}%`,
    }),
  };
});

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

const mockGetIncomeBySource = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
  },
}));

// Sorted by value descending (the stored default), so the row order is Salary,
// Interest Income, then the uncategorised row -- which carries no category id
// and so is deliberately NOT clickable.
const RESPONSE = {
  data: [
    { categoryId: 'c-salary', categoryName: 'Salary', color: '#111111', total: 5000 },
    { categoryId: 'c-interest', categoryName: 'Interest Income', color: null, total: 1200 },
    { categoryId: null, categoryName: 'Uncategorized', color: '#222222', total: 300 },
  ],
  totalIncome: 6500,
};

async function renderReport() {
  mockGetIncomeBySource.mockResolvedValue(RESPONSE);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<IncomeBySourceReport />));
  });
  // Switch from the default pie view to the table view.
  await act(async () => {
    fireEvent.click(screen.getByTitle('Table'));
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

// The account filter and the tag controls read these on mount; the report is
// the unchanged one while no key is chosen.
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
}));

describe('IncomeBySourceReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    window.localStorage.clear();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findRow(container, 'Salary');
    expect(row).toBeDefined();
    for (const caption of ['Amount', '% of Total']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Amount$5000');
    expect(rowText(row)).toContain('% of Total76.9%');
    // The identity carries NO caption -- a source name is self-describing.
    const identity = row!.querySelector('td')!;
    expect(identity.textContent).toBe('Salary');
    expect(identity.querySelector('span[class*="sm:hidden"]')).toBeNull();
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderReport();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(3);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The two figure cells (amount and share) never wrap, and each is
      // right-aligned. Right alignment is presentation, not containment.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(2);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto two lines: source beside amount, then share beneath the amount', async () => {
    const container = await renderReport();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [name, value, pct] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid grid-cols-2');
      expect(placement(name)).toBe('c1/r1');
      expect(placement(value)).toBe('c2/r1');
      expect(placement(pct)).toBe('c2/r2');
      // Nothing is placed on a third line.
      for (const cell of [name, value, pct]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('keeps the identity as an unclamped, break-words name beside its colour dot', async () => {
    const container = await renderReport();

    const identity = findRow(container, 'Salary')!.querySelector('td')!;
    // The name wraps unclamped: a clamp would cut a trailing marker before the
    // tail of the name, and no width assertion sees it.
    expect(identity.className).not.toContain('line-clamp');
    expect(identity.className).not.toContain('truncate');
    expect(identity.className).toContain('min-w-0');
    const span = identity.querySelector('span')!;
    expect(span.className).toContain('break-words');
    expect(span.className).toContain('sm:break-normal');
    expect(span.textContent).toBe('Salary');
    // The colour dot is exactly today's.
    expect(identity.querySelector('div > div')!.className).toContain('rounded-full');
  });

  it('gives the totals row the source-row placement, all three cells captioned', async () => {
    const container = await renderReport();

    const footRow = container.querySelector('tfoot tr')!;
    expect(footRow.className).toContain('grid grid-cols-2');
    const [total, value, pct] = Array.from(footRow.querySelectorAll('td'));
    expect(total.textContent).toBe('Total');
    expect(placement(total)).toBe('c1/r1');
    expect(placement(value)).toBe('c2/r1');
    expect(placement(pct)).toBe('c2/r2');

    // Every column has a total, so no footer cell leaves the DOM below `sm` and
    // none owes an `aria-colindex`.
    const footCells = Array.from(footRow.querySelectorAll('td'));
    expect(footCells).toHaveLength(3);
    for (const cell of footCells) {
      expect(cell.getAttribute('aria-colindex')).toBeNull();
    }

    // The totals carry their captions like any other cell.
    for (const cell of [value, pct]) {
      expect(cell.className).toContain('font-bold');
      expect(cell.className).toContain('whitespace-nowrap');
    }
    expect(footRow.textContent).toContain('Amount$6500');
    expect(footRow.textContent).toContain('% of Total');
    expect(footRow.textContent).toContain('100%');
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
    expect(row?.className).toContain('grid grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
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
    // EVERY `<td>` -- three data rows plus the footer, nine in all.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(12);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so both
    // header rows already carry it.
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
    expect(labelsOf(phoneRow)).toEqual(['Source', 'Amount', '% of Total']);
    // Both rows are rendered from one list, so they cannot list different
    // fields.
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
    expect(nameOrder()).toEqual(['Salary', 'Interest Income', 'Uncategorized']);

    // "Source" in the PHONE strip -- the header row that survives below `sm`,
    // identified by the class that hides it from `sm` up rather than by its
    // position. Within it the control is the first of three.
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    );
    expect(phoneStrip).toBeDefined();
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    // Ascending by name.
    expect(nameOrder()).toEqual(['Interest Income', 'Salary', 'Uncategorized']);

    // A second tap reverses it.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(nameOrder()).toEqual(['Uncategorized', 'Salary', 'Interest Income']);
  });

  it('keeps a categorised row clickable and an uncategorised one inert', async () => {
    const container = await renderReport();

    const salary = findRow(container, 'Salary')!;
    expect(salary.className).toContain('cursor-pointer');
    await act(async () => {
      fireEvent.click(salary);
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toContain('categoryId=c-salary');

    // The uncategorised row carries no category id, so it is not a pointer
    // target and navigates nowhere.
    const uncategorised = findRow(container, 'Uncategorized')!;
    expect(uncategorised.className).not.toContain('cursor-pointer');
    await act(async () => {
      fireEvent.click(uncategorised);
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('leaves the surfaces outside the table alone', async () => {
    await renderReport();

    // The controls card and its export dropdown are not part of the conversion.
    expect(screen.getByTitle('Table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
  });
});
