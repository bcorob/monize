import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import {
  SecurityComparisonChart,
  buildPerformanceView,
  type SecurityComparisonChartHandle,
} from './SecurityComparisonChart';
import type {
  PerformanceComparison,
  PerformanceExclusionReason,
  PerformanceSeriesRef,
} from '@/types/investment';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({
    name,
    strokeDasharray,
    connectNulls,
  }: {
    name?: string;
    strokeDasharray?: string;
    connectNulls?: boolean;
  }) => (
    <div
      data-testid="line"
      data-name={name}
      data-dash={strokeDasharray ?? ''}
      data-connect-nulls={String(connectNulls)}
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetPerformanceComparison = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPerformanceComparison: (...args: unknown[]) =>
      mockGetPerformanceComparison(...args),
  },
}));

const mockExportToPdf = vi.fn();
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: unknown[]) => mockExportToPdf(...args),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (d: Date) => d.toISOString().slice(0, 10),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`,
    }),
  };
});vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

function securityRef(id: string, label: string): PerformanceSeriesRef {
  return {
    key: `sec:${id}`,
    kind: 'SECURITY',
    id,
    label,
    name: `${label} Inc`,
    currencyCode: 'USD',
    basis: 'ADJUSTED',
  };
}

function indexRef(code: string, name: string): PerformanceSeriesRef {
  return {
    key: `idx:${code}`,
    kind: 'INDEX',
    id: code,
    label: code,
    name,
    currencyCode: 'USD',
    basis: 'RAW',
  };
}

function comparison(
  overrides: Partial<PerformanceComparison> = {},
): PerformanceComparison {
  return {
    window: { start: '2024-01-01', end: '2024-12-31' },
    sampling: 'day',
    series: [],
    points: [],
    totals: {},
    gaps: [],
    excluded: [],
    status: 'complete',
    ...overrides,
  };
}

describe('buildPerformanceView', () => {
  it('maps the payload to rows keyed by series', () => {
    const { rows, series } = buildPerformanceView(
      comparison({
        series: [securityRef('s1', 'AAA'), securityRef('s2', 'BBB')],
        points: [
          { date: '2024-01-01', values: { 'sec:s1': 0, 'sec:s2': 0 } },
          { date: '2024-02-01', values: { 'sec:s1': 50, 'sec:s2': -10 } },
        ],
      }),
    );
    expect(series.map((s) => s.label)).toEqual(['AAA', 'BBB']);
    expect(rows).toHaveLength(2);
    expect(rows[1]['sec:s1']).toBe(50);
    expect(rows[1]['sec:s2']).toBe(-10);
  });

  /**
   * The server goes to real trouble to send `null` rather than `0` for anything
   * it could not work out, and the last hundred pixels are where that gets
   * thrown away. A `?? 0` here would turn every gap into a measured zero.
   */
  it('carries an unknown value through as null, never as zero', () => {
    const { rows } = buildPerformanceView(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [
          { date: '2024-01-01', values: { 'sec:s1': 0 } },
          { date: '2024-02-01', values: { 'sec:s1': null } },
        ],
      }),
    );
    expect(rows[1]['sec:s1']).toBeNull();
    expect(rows[1]['sec:s1']).not.toBe(0);
  });

  it('marks an index as dashed and a security as not', () => {
    const { series } = buildPerformanceView(
      comparison({
        series: [securityRef('s1', 'AAA'), indexRef('SP500', 'S&P 500')],
      }),
    );
    expect(series[0].dashed).toBe(false);
    expect(series[1].dashed).toBe(true);
  });

  /**
   * One neutral token made every benchmark the same grey dashed line, so two
   * indexes on one chart could not be told apart. Each index now takes its own
   * palette colour -- counted from the far end, so the two kinds do not collide
   * until the palette is spent -- and the dash alone carries "benchmark".
   */
  it('gives each index its own colour, distinct from the securities', () => {
    const { series } = buildPerformanceView(
      comparison({
        series: [
          securityRef('s1', 'AAA'),
          indexRef('SP500', 'S&P 500'),
          indexRef('GSPTSE', 'S&P/TSX Composite'),
        ],
      }),
    );
    const [aaa, sp500, tsx] = series;
    expect(sp500.color).not.toBe(tsx.color);
    expect(sp500.color).not.toBe(aaa.color);
    expect(tsx.color).not.toBe(aaa.color);
    // Both still dashed: colour is identity, the dash is what says benchmark.
    expect(sp500.dashed).toBe(true);
    expect(tsx.dashed).toBe(true);
  });

  it("keeps an index's colour when a security is added beside it", () => {
    const oneSecurity = buildPerformanceView(
      comparison({
        series: [securityRef('s1', 'AAA'), indexRef('SP500', 'S&P 500')],
      }),
    );
    const twoSecurities = buildPerformanceView(
      comparison({
        series: [
          securityRef('s1', 'AAA'),
          securityRef('s2', 'BBB'),
          indexRef('SP500', 'S&P 500'),
        ],
      }),
    );
    const indexColorOf = (view: ReturnType<typeof buildPerformanceView>) =>
      view.series.find((s) => s.kind === 'INDEX')?.color;
    expect(indexColorOf(twoSecurities)).toBe(indexColorOf(oneSecurity));
  });

  /**
   * A holding's colour must not move when a benchmark is added beside it: the
   * reader has already learned which line is theirs.
   */
  it('colours securities from the palette independently of any indexes', () => {
    const withoutIndex = buildPerformanceView(
      comparison({ series: [securityRef('s1', 'AAA'), securityRef('s2', 'BBB')] }),
    );
    const withIndex = buildPerformanceView(
      comparison({
        series: [
          securityRef('s1', 'AAA'),
          securityRef('s2', 'BBB'),
          indexRef('SP500', 'S&P 500'),
        ],
      }),
    );
    expect(withIndex.series[0].color).toBe(withoutIndex.series[0].color);
    expect(withIndex.series[1].color).toBe(withoutIndex.series[1].color);
  });
});

describe('SecurityComparisonChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPerformanceComparison.mockResolvedValue(comparison());
  });

  async function renderChart(props: Partial<{
    securityIds: string[];
    indexCodes: string[];
    startDate: string;
    endDate: string;
    exportRef: { current: SecurityComparisonChartHandle | null };
  }> = {}) {
    await act(async () => {
      render(
        <SecurityComparisonChart
          securityIds={props.securityIds ?? ['s1', 's2']}
          indexCodes={props.indexCodes ?? []}
          startDate={props.startDate ?? '2024-01-01'}
          endDate={props.endDate ?? '2024-12-31'}
          exportRef={props.exportRef}
        />,
      );
    });
  }

  it('renders one line per returned series', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA'), securityRef('s2', 'BBB')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0, 'sec:s2': 0 } }],
      }),
    );
    await renderChart();

    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(2));
    const names = screen
      .getAllByTestId('line')
      .map((l) => l.getAttribute('data-name'));
    expect(names).toEqual(expect.arrayContaining(['AAA', 'BBB']));
  });

  it('sends the window and the selection to the server', async () => {
    await renderChart({
      securityIds: ['s1'],
      indexCodes: ['SP500'],
      startDate: '2020-01-01',
      endDate: '2025-12-31',
    });
    await waitFor(() =>
      expect(mockGetPerformanceComparison).toHaveBeenCalledWith({
        securityIds: ['s1'],
        indexCodes: ['SP500'],
        startDate: '2020-01-01',
        endDate: '2025-12-31',
      }),
    );
  });

  it('treats an empty start as all history rather than as a filter', async () => {
    await renderChart({ startDate: '' });
    await waitFor(() =>
      expect(mockGetPerformanceComparison).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: undefined }),
      ),
    );
  });

  /**
   * `connectNulls` draws a straight segment through the gap, indistinguishable
   * from measured data -- and a tooltip saying "unknown" under the cursor does
   * not undo it (`docs/frontend/financial-figures.md`, `docs/time-series-contract.md` rule 3).
   */
  it('never bridges a gap in a line', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [
          { date: '2024-01-01', values: { 'sec:s1': 0 } },
          { date: '2024-06-01', values: { 'sec:s1': null } },
        ],
        gaps: [{ key: 'sec:s1', from: '2024-06-01', to: '2024-06-01' }],
        status: 'incomplete',
      }),
    );
    await renderChart();

    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(1));
    expect(screen.getByTestId('line').getAttribute('data-connect-nulls')).toBe(
      'false',
    );
  });

  it('draws a benchmark dashed and a holding solid', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA'), indexRef('SP500', 'S&P 500')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0, 'idx:SP500': 0 } }],
      }),
    );
    await renderChart({ indexCodes: ['SP500'] });

    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(2));
    const dashes = screen
      .getAllByTestId('line')
      .map((l) => l.getAttribute('data-dash'));
    expect(dashes).toEqual(['', '5 3']);
  });

  it('labels an index line with its localized name', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [indexRef('SP500', 'S&P 500')],
        points: [{ date: '2024-01-01', values: { 'idx:SP500': 0 } }],
      }),
    );
    await renderChart({ securityIds: [], indexCodes: ['SP500'] });

    await waitFor(() =>
      expect(screen.getByTestId('line').getAttribute('data-name')).toBe(
        'S&P 500',
      ),
    );
  });

  /**
   * A refused series that simply vanishes turns a request for three instruments
   * into a chart of two, and the chart reads as complete.
   */
  it.each<[PerformanceExclusionReason, RegExp]>([
    ['NO_PRICE_HISTORY', /no price history is stored/i],
    ['NO_PRICE_AT_WINDOW_START', /no price close enough to the start/i],
    ['NON_POSITIVE_BASE', /not a usable figure/i],
    ['SINGLE_OBSERVATION', /only one price in this window/i],
  ])('names an excluded series and why (%s)', async (reason, copy) => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0 } }],
        excluded: [
          {
            key: 'sec:s2',
            kind: 'SECURITY',
            id: 's2',
            label: 'BBB',
            reason,
          },
        ],
        status: 'incomplete',
      }),
    );
    await renderChart();

    await waitFor(() =>
      expect(screen.getByText(/Not shown on this chart/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByText(/BBB/)).toBeInTheDocument();
  });

  it('discloses an incomplete chart', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0 } }],
        status: 'incomplete',
      }),
    );
    await renderChart();

    await waitFor(() =>
      expect(
        screen.getByText(/Part of this chart could not be measured/i),
      ).toBeInTheDocument(),
    );
  });

  it('says nothing about completeness when the chart is complete', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0 } }],
      }),
    );
    await renderChart();

    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(1));
    expect(
      screen.queryByText(/Part of this chart could not be measured/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Not shown on this chart/i)).not.toBeInTheDocument();
  });

  it('shows the no-data message when nothing could be priced', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({ status: 'incomplete' }),
    );
    await renderChart();

    await waitFor(() =>
      expect(
        screen.getByText(/None of the selected instruments could be priced/i),
      ).toBeInTheDocument(),
    );
  });

  /**
   * A failed request is not an empty dataset: rendering the failure as
   * emptiness turns an outage into a plausible answer.
   */
  it('shows the error state rather than an empty chart when the request fails', async () => {
    mockGetPerformanceComparison.mockRejectedValue(new Error('boom'));
    await renderChart();
    await act(async () => {});

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load price history/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('line')).not.toBeInTheDocument();
  });

  it('exports the comparison chart to PDF through the export handle', async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA'), indexRef('SP500', 'S&P 500')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0, 'idx:SP500': 0 } }],
      }),
    );
    const ref: { current: SecurityComparisonChartHandle | null } = { current: null };
    await renderChart({ indexCodes: ['SP500'], exportRef: ref });
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(2));

    await act(async () => {
      await ref.current!.exportPdf();
    });

    expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    const call = mockExportToPdf.mock.calls[0][0];
    expect(call.title).toBe('Performance Comparison');
    expect(call.subtitle).toBe('AAA, S&P 500');
    expect(call.filename).toBe('security-performance-comparison');
    expect(call.chartContainer).toBeInstanceOf(HTMLElement);
    // The Recharts legend is HTML, not part of the captured SVG, so the PDF
    // redraws it -- and the benchmark has to stay identifiable as one there.
    expect(call.chartLegend).toEqual([
      { color: expect.stringMatching(/^#/), label: 'AAA - AAA Inc' },
      { color: expect.stringMatching(/^#/), label: 'S&P 500 (index)' },
    ]);
  });

  it('renders the default comparison subtitle when none is supplied', async () => {
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0 } }],
      }),
    );
    await renderChart();
    await waitFor(() =>
      expect(screen.getByText(/each selected instrument/i)).toBeInTheDocument(),
    );
  });

  it('renders a supplied subtitle and uses it as the PDF description', async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetPerformanceComparison.mockResolvedValue(
      comparison({
        series: [securityRef('s1', 'AAA')],
        points: [{ date: '2024-01-01', values: { 'sec:s1': 0 } }],
      }),
    );
    const ref: { current: SecurityComparisonChartHandle | null } = { current: null };
    await act(async () => {
      render(
        <SecurityComparisonChart
          securityIds={['s1']}
          indexCodes={[]}
          startDate="2024-01-01"
          endDate="2024-12-31"
          subtitle="Whole portfolio over the selected period."
          exportRef={ref}
        />,
      );
    });
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(1));

    // Shown above the chart, and it replaces the "selected instrument" copy.
    expect(
      screen.getByText('Whole portfolio over the selected period.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/each selected instrument/i)).not.toBeInTheDocument();

    await act(async () => {
      await ref.current!.exportPdf();
    });
    expect(mockExportToPdf.mock.calls[0][0].description).toBe(
      'Whole portfolio over the selected period.',
    );
  });
});
