import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetVsActualReport } from './BudgetVsActualReport';
import type { Budget, BudgetTrendPoint } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetTrend = vi.fn();
const mockGetCategoryTrend = vi.fn();
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
    getCategoryTrend: (...args: any[]) => mockGetCategoryTrend(...args),
  },
}));

const mockGetIncomeVsExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

const mockGetAllTags = vi.fn();
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: (...args: any[]) => mockGetAllTags(...args) },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'USD',
    }),
  };
});
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatMonth: (m: string) => `table:${m}` }),
}));
vi.mock('@/hooks/useChartMonthFormat', () => ({
  useChartMonthFormat: () => (m: string) => `chart:${m}`,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/pdf-export', () => ({ exportToPdf: vi.fn() }));
vi.mock('@/components/budgets/BudgetCategoryTrend', () => ({
  BudgetCategoryTrend: () => <div data-testid="cat-trend" />,
}));

// What the mocked chart was last given.
let lastChartData: any[] = [];
let lastTooltipContent: ((props: any) => any) | null = null;
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children, data }: any) => {
    lastChartData = data;
    return <div data-testid="bar-chart">{children}</div>;
  },
  Bar: ({ dataKey, name }: any) => <div data-testid={`bar-${dataKey}`} data-name={name} />,
  // The variance chart's own tooltip is not under test: leave it unrendered so
  // the overview chart's is the one captured.
  LineChart: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') lastTooltipContent = content;
    return null;
  },
}));

const point = (monthKey: string, budgeted: number, actual: number): BudgetTrendPoint => ({
  monthKey,
  budgeted,
  actual,
  variance: actual - budgeted,
  percentUsed: Math.round((actual / budgeted) * 100),
});
const TREND = [point('2025-01', 3000, 2500), point('2025-02', 8000, 8486), point('2025-03', 8000, 7000)];

const totals = { income: 9279, expenses: 0, net: 0, knownIncome: 9279, knownExpenses: 0, knownNet: 0 };
const period = (p: string, income: number) => ({
  period: p,
  periodStart: `${p}-01`,
  periodEnd: `${p}-28`,
  income,
  expenses: 0,
  net: income,
});
const flow = (p: string, taggedInflows: number, taggedOutflows = 0) => ({
  ...period(p, 0),
  taggedInflows,
  taggedOutflows,
});
const funding = (over: Record<string, unknown> = {}, bucketOver: Record<string, unknown> = {}) => ({
  data: [period('2025-01', 3000), period('2025-02', 3279), period('2025-03', 3000)],
  totals,
  currency: 'USD',
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: 'scope',
  buckets: [
    {
      value: 'household',
      isUntagged: false,
      data: [flow('2025-01', 0), flow('2025-02', 4516), flow('2025-03', 0, 100)],
      totals,
      taggedInflows: 4516,
      taggedOutflows: 100,
      missingCurrencies: [],
      excludedCount: 0,
      ...bucketOver,
    },
  ],
  ...over,
});

async function renderReport() {
  await act(async () => {
    render(<BudgetVsActualReport />);
  });
  await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
}
async function chooseScopeHousehold() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Break down by tag key'), { target: { value: 'scope' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Tag value'), { target: { value: 'household' } });
  });
}
const turnSwitchOn = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Include tagged transfers' }));
  });
};
function renderTooltip(monthKey: string) {
  const datum = lastChartData.find((d) => d.monthKey === monthKey);
  let view: ReturnType<typeof render>;
  act(() => {
    view = render(<div>{lastTooltipContent!({ active: true, payload: [{ payload: datum }], label: monthKey })}</div>);
  });
  return view!;
}

describe('BudgetVsActualReport funding view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    lastChartData = [];
    lastTooltipContent = null;
    mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
    mockGetTrend.mockResolvedValue(TREND);
    mockGetCategoryTrend.mockResolvedValue([]);
    mockGetAllTags.mockResolvedValue([{ id: 't1', name: 'scope:household' }]);
  });

  it("is today's chart with no tag key: trend rows untouched, no funding call, no extra series", async () => {
    mockGetAllTags.mockResolvedValue([]);
    await renderReport();
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(lastChartData).toEqual(TREND);
    expect(screen.queryByTestId('bar-availableFunds')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Break down by tag key')).not.toBeInTheDocument();
  });

  it('changes nothing with a key and a value chosen but the switch off', async () => {
    await renderReport();
    await chooseScopeHousehold();
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(lastChartData).toEqual(TREND);
    expect(screen.queryByTestId('bar-availableFunds')).not.toBeInTheDocument();
  });

  it('adds Available funds per month, aligned by monthKey, and leaves the budget figures alone', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();

    await waitFor(() => expect(screen.getByTestId('bar-availableFunds')).toBeInTheDocument());
    // The window is the trend's months: first of January to the end of March.
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      startDate: '2025-01-01',
      endDate: '2025-03-31',
      bucket: 'month',
      tagKey: 'scope',
    });
    expect(lastChartData.map((d) => d.availableFunds)).toEqual([3000, 7795, 2900]);
    lastChartData.forEach((d, i) => {
      expect(d).toMatchObject(TREND[i]);
    });
    expect(screen.getByTestId('bar-availableFunds')).toHaveAttribute('data-name', 'Available funds (household)');
  });

  it('tooltip adds Available funds and Actual vs available (7,795 against 8,486 is -691)', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('bar-availableFunds')).toBeInTheDocument());

    const view = renderTooltip('2025-02');
    expect(view.container).toHaveTextContent('Budgeted: $8000.00');
    expect(view.container).toHaveTextContent('Actual: $8486.00');
    expect(view.container).toHaveTextContent('Available funds: $7795.00');
    expect(view.container).toHaveTextContent('Actual vs available: $-691.00');
  });

  it('shows a month the funding answer lacks as unknown, not zero', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding({ data: [period('2025-01', 3000), period('2025-02', 3279)] }),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('bar-availableFunds')).toBeInTheDocument());

    expect(lastChartData[2].availableFunds).toBeNull();
    const view = renderTooltip('2025-03');
    expect(view.container).toHaveTextContent('Available funds: —');
    expect(view.container).toHaveTextContent('Actual vs available: —');
    expect(view.container).not.toHaveTextContent('$0.00');
  });

  it('marks the series and the tooltip as subtotals when a rate is missing, and names the currency', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding({ missingCurrencies: ['EUR'], excludedCount: 1 }));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('bar-availableFunds')).toBeInTheDocument());
    expect(screen.getByTestId('bar-availableFunds')).toHaveAttribute('data-name', 'Available funds (household)*');
    expect(screen.getByText(/no exchange rate for EUR/)).toBeInTheDocument();
    expect(renderTooltip('2025-02').container).toHaveTextContent('Available funds: $7795.00*');
  });

  it('says so when the funding request fails, leaving the budget chart in place', async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error('boom'));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(screen.getByText('The tagged transfer figures could not be loaded.')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('bar-availableFunds')).not.toBeInTheDocument();
    expect(lastChartData).toEqual(TREND);
  });

  it('offers no funding controls and makes no funding call in the by-category view', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'By Category' }));
    });
    expect(screen.queryByLabelText('Break down by tag key')).not.toBeInTheDocument();
    expect(screen.getByTestId('cat-trend')).toBeInTheDocument();
  });
});
