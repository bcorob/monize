import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { HealthScoreHistoryReport } from './HealthScoreHistoryReport';
import type { Budget, HealthScoreHistoryPoint } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetHealthScoreHistory = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getHealthScoreHistory: (...args: any[]) => mockGetHealthScoreHistory(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

// The month column renders through the user's date preference and the chart
// axis through the chart month formatter, so both are pinned. The table labels
// are deliberately anti-chronological in alphabetical order (Zulu, Yankee, ...
// for Jan, Feb, ...): a sort that reads the LABEL rather than the key shows up
// as a reversed table.
const MONTH_LABELS: Record<string, string> = {
  '2025-01': 'Zulu month',
  '2025-02': 'Yankee month',
  '2025-03': 'Xray month',
  '2025-04': 'Whiskey month',
  '2025-05': 'Victor month',
  '2025-06': 'Uniform month',
};

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatMonth: (monthKey: string) => MONTH_LABELS[monthKey] ?? `localized:${monthKey}`,
  }),
}));

vi.mock('@/hooks/useChartMonthFormat', () => ({
  useChartMonthFormat: () => (monthKey: string) => `chart:${monthKey}`,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="rc">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    // Render the custom tooltip with mock data to exercise its logic
    const C = content;
    if (!C) return null;
    const samples: any[] = [
      { active: true, payload: [{ payload: { monthKey: '2025-01', score: 95, label: 'Excellent' } }], label: '2025-01' },
      { active: true, payload: [{ payload: { monthKey: '2025-02', score: 75, label: 'Fair' } }], label: '2025-02' },
      { active: true, payload: [{ payload: { monthKey: '2025-03', score: 55, label: 'Poor' } }], label: '2025-03' },
      { active: true, payload: [{ payload: { monthKey: '2025-04', score: 30, label: 'Critical' } }], label: '2025-04' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [{ payload: undefined }], label: 'no point' },
    ];
    return (
      <div data-testid="tooltip-host">
        {samples.map((s, i) => (
          <div key={i}>{C(s)}</div>
        ))}
      </div>
    );
  },
  ReferenceLine: () => null,
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePoint = (
  monthKey: string,
  score: number,
): HealthScoreHistoryPoint => ({ monthKey, score, label: 'x' });

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<HealthScoreHistoryReport />);
  });
  return result!;
}

describe('HealthScoreHistoryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton initially', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<HealthScoreHistoryReport />);
      container = r.container;
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders no-budgets state', async () => {
    mockGetAll.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('renders empty history message when no data', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No health score history/i)).toBeInTheDocument();
    });
    // Trajectory shows '--' when fewer than 2 points
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('falls back to first budget when none active', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-x', isActive: false }),
      makeBudget({ id: 'b-y', isActive: false }),
    ]);
    mockGetHealthScoreHistory.mockResolvedValue([]);
    await renderReport();
    await waitFor(() =>
      expect(mockGetHealthScoreHistory).toHaveBeenCalledWith('b-x', 12),
    );
  });

  it('renders summary cards and history table covering grade variants and improving trajectory', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    // Cover excellent (>=90), good (>=80), fair (>=60), poor (>=40), critical (<40), and increasing trajectory
    mockGetHealthScoreHistory.mockResolvedValue([
      makePoint('2025-01', 30), // critical
      makePoint('2025-02', 50), // poor
      makePoint('2025-03', 65), // fair
      makePoint('2025-04', 65), // fair (no change)
      makePoint('2025-05', 85), // good - improving
      makePoint('2025-06', 95), // excellent
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Score History')).toBeInTheDocument();
    });
    // Month rows: a localized label, never the structural key the server sends.
    expect(screen.getByText('Zulu month')).toBeInTheDocument();
    expect(screen.getByText('Uniform month')).toBeInTheDocument();
    expect(screen.queryByText('2025-01')).not.toBeInTheDocument();

    // Ascending is the default and these labels sort alphabetically in the
    // opposite order, so January staying first proves the sort reads the key
    // rather than the text on screen.
    const renderedMonths = Array.from(document.querySelectorAll('tbody tr')).map(
      (row) => row.querySelector('td')?.textContent,
    );
    expect(renderedMonths).toEqual([
      'Zulu month',
      'Yankee month',
      'Xray month',
      'Whiskey month',
      'Victor month',
      'Uniform month',
    ]);

    // The chart axis and its tooltip use the chart formatter, not the table's.
    expect(screen.getAllByText('chart:2025-01').length).toBeGreaterThan(0);
    // Grade variants are rendered
    expect(screen.getAllByText('Excellent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fair').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Poor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
    // Trajectory: improving from 30 -> 95 should show 'Up'
    expect(screen.getByText('Up')).toBeInTheDocument();
    // Change column: +20, +15, 0, +20, +10
    expect(screen.getAllByText('+20').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('renders descending trajectory (Down) and negative changes', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockResolvedValue([
      makePoint('2025-01', 90),
      makePoint('2025-02', 60),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Down')).toBeInTheDocument();
    });
    // Negative change rendered
    expect(screen.getByText('-30')).toBeInTheDocument();
  });

  it('switches months selector and refetches', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockResolvedValue([]);
    await renderReport();
    await waitFor(() =>
      expect(mockGetHealthScoreHistory).toHaveBeenCalledWith('b-1', 12),
    );
    const selects = document.querySelectorAll('select');
    // Second select is months
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: '24' } });
    });
    await waitFor(() =>
      expect(mockGetHealthScoreHistory).toHaveBeenCalledWith('b-1', 24),
    );
  });

  it('switches budget selector', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1', name: 'A' }),
      makeBudget({ id: 'b-2', name: 'B', isActive: false }),
    ]);
    mockGetHealthScoreHistory.mockResolvedValue([]);
    await renderReport();
    const select = document.querySelector('select')!;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'b-2' } });
    });
    await waitFor(() =>
      expect(mockGetHealthScoreHistory).toHaveBeenCalledWith('b-2', 12),
    );
  });

  it('shows a retryable error when loading budgets fails', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('shows a retryable error when loading history fails', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('exports to PDF with summary cards and history table', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockResolvedValue([
      makePoint('2025-01', 90),
      makePoint('2025-02', 70),
      makePoint('2025-03', 55),
    ]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Health Score History');
    expect(arg.summaryCards.length).toBe(5);
    // Down trajectory since first > last
    const traj = arg.summaryCards.find((c: any) => c.label === 'Trajectory');
    expect(traj.value).toBe('Down');
    expect(arg.additionalTables[0].rows.length).toBe(3);
    // The PDF is a reading surface, so its month column is localized too.
    expect(arg.additionalTables[0].rows[0][0]).toBe('Zulu month');
  });

  it('exports to PDF when no data renders no additional tables', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScoreHistory.mockResolvedValue([]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.additionalTables).toBeUndefined();
    const cur = arg.summaryCards.find((c: any) => c.label === 'Current Score');
    expect(cur.value).toBe('0');
  });
});
