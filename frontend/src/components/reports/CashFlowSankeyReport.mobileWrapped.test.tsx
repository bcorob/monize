import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import { CashFlowSankeyReport } from './CashFlowSankeyReport';
import type { CashFlowSankeyNode, CashFlowSankeyResponse } from '@/types/built-in-reports';

/**
 * The phone layout of the Cash Flow Sankey's table twin.
 *
 * A phone defaults to the table (the diagram's columns do not reflow), and the
 * table is ONE tree restyled by CSS: below `sm` each row wraps into a two-track
 * card -- the flow's name on line 1, its direction and its amount on line 2 --
 * and the column header row is hidden; from `sm` up it is the ordinary table.
 * jsdom applies no media queries, so the phone captions are in the DOM here.
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults() }) };
});

vi.mock('@/hooks/useDateRange', () => {
  const resolvedRange = { start: '2026-09-01', end: '2026-09-30' };
  return {
    useDateRange: () => ({
      dateRange: 'mtd',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange,
      isValid: true,
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: () => <div data-testid="scope-picker" />,
}));

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const mockGetSankey = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getCashFlowSankey: (...args: unknown[]) => mockGetSankey(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: () => Promise.resolve([]) },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function node(id: string, label: string, total: number | null, extra: Partial<CashFlowSankeyNode> = {}): CashFlowSankeyNode {
  return {
    id,
    kind: (id === 'hub' ? 'hub' : id.split(':')[0]) as CashFlowSankeyNode['kind'],
    label,
    categoryId: null,
    parentCategoryId: null,
    accountId: null,
    color: null,
    total,
    knownTotal: total ?? 0,
    ...extra,
  };
}

const RESPONSE: CashFlowSankeyResponse = {
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  currency: 'CAD',
  scopeAccountIds: ['acc-chq'],
  nodes: [
    node('income:cat-salary', 'Salary', 5000, { categoryId: 'cat-salary' }),
    node('hub', 'Income', 5000),
    node('expense:cat-groceries', 'Groceries', 600, { categoryId: 'cat-groceries' }),
    node('class:savings', 'Savings & investments', 1000),
    node('residual:unspent', 'Unspent', 3400),
  ],
  links: [
    { source: 'income:cat-salary', target: 'hub', amount: 5000, knownAmount: 5000 },
    { source: 'hub', target: 'expense:cat-groceries', amount: 600, knownAmount: 600 },
    { source: 'hub', target: 'class:savings', amount: 1000, knownAmount: 1000 },
    { source: 'hub', target: 'residual:unspent', amount: 3400, knownAmount: 3400 },
  ],
  totals: { income: 5000, inflows: 0, expenses: 600, outflows: 1000, unspent: 3400, deficit: 0 },
  knownTotals: { income: 5000, inflows: 0, expenses: 600, outflows: 1000 },
  missingCurrencies: [],
  excludedCount: 0,
};

async function renderTable() {
  mockGetSankey.mockResolvedValue(RESPONSE);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CashFlowSankeyReport />));
  });
  return container;
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};

describe('CashFlowSankeyReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens on the table, with no diagram, on a phone', async () => {
    await renderTable();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
  });

  it('captions the direction and the amount inside each row', async () => {
    const container = await renderTable();
    const row = container.querySelector('[data-testid="sankey-row-expense:cat-groceries"]')!;
    expect(row.textContent).toContain('DirectionMoney out');
    expect(row.textContent).toContain('Amount$600.00');
    // The identity is self-describing and carries no caption.
    expect(row.querySelector('td')!.textContent).toBe('Groceries');
  });

  it('places every cell on the phone grid explicitly', async () => {
    const container = await renderTable();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    // Every node but the hub.
    expect(rows).toHaveLength(RESPONSE.nodes.length - 1);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells.map(placement)).toEqual(['c1/r1', 'c1/r2', 'c2/r2']);
    }
  });

  it('never wraps a figure, and restores the desktop size from sm up', async () => {
    const container = await renderTable();
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const amount = row.querySelectorAll('td')[2];
      expect(amount.className).toContain('whitespace-nowrap');
      expect(amount.className).toContain('text-right');
      expect(amount.className).toContain('text-xs');
      expect(amount.className).toContain('sm:text-sm');
      expect(amount.className).toContain('sm:table-cell');
    }
  });

  it('hides the column header row on a phone and keeps the table roles', async () => {
    const container = await renderTable();
    const thead = container.querySelector('thead')!;
    expect(thead.className).toContain('hidden');
    expect(thead.className).toContain('sm:table-header-group');
    expect(container.querySelector('table')!.getAttribute('role')).toBe('table');
    expect(container.querySelectorAll('[role="cell"]').length).toBe((RESPONSE.nodes.length - 1) * 3);
  });

  it('makes a drillable row a keyboard target and leaves the residual inert', async () => {
    const container = await renderTable();
    const groceries = container.querySelector('[data-testid="sankey-row-expense:cat-groceries"]')!;
    const residual = container.querySelector('[data-testid="sankey-row-residual:unspent"]')!;
    expect(groceries.getAttribute('tabindex')).toBe('0');
    expect(residual.getAttribute('tabindex')).toBeNull();
  });
});
