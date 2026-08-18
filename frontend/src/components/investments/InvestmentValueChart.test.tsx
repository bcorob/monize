import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import {
  InvestmentValueChart,
  INVESTMENT_CHART_REFRESH_EVENT,
} from './InvestmentValueChart';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { usePreferencesStore } from '@/store/preferencesStore';

const dateRangeState = { dateRange: '1y', resolvedRange: { start: '2023-01-01', end: '2024-01-01' } };

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children, margin }: any) => (
    <div data-testid="area-chart" data-margin={JSON.stringify(margin)}>{children}</div>
  ),
  // Invoke the dot render-prop so the high/low value bubbles (and their dismiss
  // controls) are exercised; indices 0..2 cover both extremes of the test
  // series. Existing tests are unaffected -- the bubble labels use the compact
  // flag formatter (no decimals), distinct from the ".00" summary figures.
  Area: ({ dot }: any) =>
    typeof dot === 'function' ? (
      <div data-testid="line-dots">
        {dot({ cx: 10, cy: 20, index: 0 })}
        {dot({ cx: 30, cy: 40, index: 1 })}
        {dot({ cx: 50, cy: 60, index: 2 })}
      </div>
    ) : null,
  XAxis: () => null,
  YAxis: ({ width }: any) => <div data-testid="y-axis" data-width={width ?? ''} />,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceDot: () => null,
}));

/** Toggle the useIsMobile media query for a single test. */
function setViewport(isMobile: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: query.includes('max-width') ? isMobile : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    formatCurrencyFlag: (n: number, _currency?: string) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: () => null,
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: dateRangeState.dateRange,
    setDateRange: vi.fn(),
    resolvedRange: dateRangeState.resolvedRange,
    isValid: true,
  }),
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsDaily: vi.fn().mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]),
    getInvestmentsMonthly: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getIntradayValue: vi.fn().mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    }),
  },
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: any) => [initial, vi.fn()],
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

describe('InvestmentValueChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A null store is the pre-load state, where the hook takes the default.
    usePreferencesStore.setState({ preferences: null });
    dateRangeState.dateRange = '1y';
    dateRangeState.resolvedRange = { start: '2023-01-01', end: '2024-01-01' };
    // 1y is a daily range, so mock getInvestmentsDaily
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]);
  });

  it('renders loading state initially', async () => {
    render(<InvestmentValueChart />);
    await waitFor(() => {
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  it('renders title after data loads', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title).toBeInTheDocument();
  });

  it('links to the full Portfolio Value report', async () => {
    render(<InvestmentValueChart />);
    const link = await screen.findByRole('link', { name: /View report/i });
    expect(link).toHaveAttribute('href', '/reports/portfolio-value');
  });

  it('renders summary cards after data loads', async () => {
    render(<InvestmentValueChart />);
    const highest = await screen.findByText('Highest Value');
    expect(highest).toBeInTheDocument();
    expect(screen.getByText('Lowest Value')).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Change %')).toBeInTheDocument();
  });

  it('renders the chart component after data loads', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('temporarily hides a value bubble when its dismiss control is clicked', async () => {
    const { container } = render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const labels = () =>
      Array.from(
        container.querySelectorAll('[data-testid="line-dots"] text'),
      ).map((node) => node.textContent);
    // highest=15000 (index 1), lowest=10000 (index 0) -> a bubble each.
    await waitFor(() => {
      expect(labels()).toEqual(expect.arrayContaining(['$10000', '$15000']));
    });

    const closeControls = container.querySelectorAll('.chart-flag-dismiss');
    expect(closeControls).toHaveLength(2);
    // The second control belongs to the high bubble (dot index 1).
    await act(async () => {
      fireEvent.click(closeControls[1]);
    });

    expect(labels()).toContain('$10000');
    expect(labels()).not.toContain('$15000');
  });

  it('uses generous chart margins on desktop', async () => {
    setViewport(false);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const margin = JSON.parse(
      screen.getByTestId('area-chart').getAttribute('data-margin') || '{}',
    );
    expect(margin).toEqual({ top: 30, right: 30, left: 0, bottom: 30 });
    // Default YAxis width (no explicit override) on desktop.
    expect(screen.getByTestId('y-axis').getAttribute('data-width')).toBe('');
  });

  it('reclaims wasted space with tighter margins on mobile', async () => {
    setViewport(true);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const margin = JSON.parse(
      screen.getByTestId('area-chart').getAttribute('data-margin') || '{}',
    );
    expect(margin).toEqual({ top: 16, right: 8, left: 0, bottom: 8 });
    // Narrower YAxis gutter on mobile.
    expect(screen.getByTestId('y-axis').getAttribute('data-width')).toBe('44');
  });

  it('displays computed summary values', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // highest=15000, lowest=10000, change=+5000, percent=+50.0%
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    expect(screen.getByText('+$5000.00')).toBeInTheDocument();
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
  });

  it('shows no data message when API returns empty', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('handles API failure gracefully', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(new Error('Network error'));
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('passes accountIds to API when provided', async () => {
    render(<InvestmentValueChart accountIds={['acc-1', 'acc-2']} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: 'acc-1,acc-2',
      })
    );
  });

  it('does not pass accountIds when empty array', async () => {
    render(<InvestmentValueChart accountIds={[]} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: undefined,
      })
    );
  });

  it('passes date filter ranges including mtd between 1w and 1m to DateRangeSelector', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    expect(lastCall.ranges).toEqual(['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('uses intraday API for mtd range and passes 1m to backend', async () => {
    dateRangeState.dateRange = 'mtd';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-15' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-01T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-10T14:30:00.000Z', value: 9700 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: '1m',
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
      expect.objectContaining({ range: '1m' }),
    );
    // The daily endpoint is still reached, but only for the prior-close
    // baseline -- its window ends the day before the chart's first point, so
    // none of the plotted series comes from it.
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1);
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: '2023-12-31' }),
    );
  });

  it('filters mtd intraday points to current month only', async () => {
    dateRangeState.dateRange = 'mtd';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-15' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2023-12-28T14:30:00.000Z', value: 8000 },
        { timestamp: '2024-01-01T14:30:00.000Z', value: 9000 },
        { timestamp: '2024-01-10T14:30:00.000Z', value: 10000 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: '1m',
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // highest should be 10000 (Jan 10), not 9000 or 8000 from December
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    // December point (8000) filtered out, so lowest is 9000
    expect(screen.getByText('$9000.00')).toBeInTheDocument();
  });

  it('shows negative change values correctly', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 20000 },
      { date: '2024-01-01', value: 15000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
    expect(screen.getByText('-25.0%')).toBeInTheDocument();
  });

  it('uses daily API for 1y range (DAILY_RANGES)', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses daily API for 2y range (DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '2y';
    dateRangeState.resolvedRange = { start: '2022-01-01', end: '2024-01-01' };
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses intraday API for 1d range', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-02T14:31:00.000Z', value: 9600 },
      ],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
      expect.objectContaining({ range: '1d' }),
    );
    // As above: the only daily call is the prior-close baseline, whose window
    // ends the day before the session on screen.
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1);
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: '2024-01-01' }),
    );
  });

  describe('prior-close change baseline', () => {
    /** Text of the summary card carrying `label`. */
    const card = (label: string) => screen.getByText(label).parentElement!.textContent;

    const intraday = (points: Array<{ timestamp: string; value: number }>) => ({
      points,
      interval: '15m' as const,
      currency: 'CAD',
      range: '1d' as const,
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });

    it('measures the 1w change from the close before the week shown', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-08T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T14:30:00.000Z', value: 11000 },
        ]),
      );
      // Jan 6/7 is a weekend, so the daily series' Jan 7 point already carries
      // Friday Jan 5's close -- which is the previous trading day.
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2024-01-05', value: 9000 },
        { date: '2024-01-06', value: 9000 },
        { date: '2024-01-07', value: 9000 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
          expect.objectContaining({ endDate: '2024-01-07' }),
        ),
      );
      await waitFor(() => expect(card('Change')).toContain('+$2000.00'));
      // Not the change from the first point plotted, which is what this
      // measured before and would still read as plausible.
      expect(card('Change')).not.toContain('+$1000.00');
      expect(card('Change %')).toContain('+22.2%');
    });

    it('measures the mtd change from the close before the month started', async () => {
      dateRangeState.dateRange = 'mtd';
      dateRangeState.resolvedRange = { start: '2024-02-01', end: '2024-02-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-02-01T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-02-15T14:30:00.000Z', value: 10500 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2024-01-31', value: 9500 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
          expect.objectContaining({ endDate: '2024-01-31' }),
        ),
      );
      await waitFor(() => expect(card('Change')).toContain('+$1000.00'));
    });

    it('measures the 1d change from the previous session, not from the open', async () => {
      dateRangeState.dateRange = '1d';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-15T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T20:00:00.000Z', value: 10200 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2024-01-14', value: 10400 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      // Up 200 since the open, down 200 against the previous close: the two
      // answers have opposite signs, so only one of them can be on screen.
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
          expect.objectContaining({ endDate: '2024-01-14' }),
        ),
      );
      await waitFor(() => expect(card('Change')).toContain('-200.00'));
      expect(card('Change')).not.toContain('+$200.00');
      expect(card('Change %')).toContain('-1.9%');
    });

    it('reports the change as unknown when the baseline cannot be loaded', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-08T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T14:30:00.000Z', value: 11000 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(
        new Error('baseline unavailable'),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      // A missing baseline is not a change of zero, and not the first point's
      // change wearing the prior close's label.
      await waitFor(() => expect(card('Change')).toContain('N/A'));
      expect(card('Change %')).toContain('N/A');
      expect(card('Change')).not.toContain('$1000.00');
    });

    /**
     * The period-start alternative was a user preference
     * (`portfolio_change_baseline`, migration 152, dropped by 153). With it
     * gone, a prior-close range always looks the close up -- there is no
     * stored setting that can turn it off.
     */
    it('always uses the prior close on a short range', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-08T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T14:30:00.000Z', value: 11000 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2024-01-07', value: 9000 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      // From 9000, not from the 10000 first point.
      await waitFor(() => expect(card('Change')).toContain('+$2000.00'));
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });

    it('still measures a long range from the first point plotted', async () => {
      // 1y: its first point already is a close, so no separate baseline
      // request is made. The window's own start comes from the portfolio
      // rule rather than from useDateRange -- pinned in the test below, and
      // exhaustively in portfolio-range-window.test.ts.
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');
      await waitFor(() => expect(card('Change')).toContain('+$5000.00'));
      // One call, for the chart itself -- no baseline lookup.
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1);
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ endDate: '2024-01-01' }),
      );
    });

    /**
     * The window a price chart requests is not the period the range names: 1Y
     * opens on the close of the day *before* the anniversary, so on
     * 12 Aug 2026 the first point is 11 Aug 2025. The clock is pinned because
     * otherwise this is a test about the day it ran.
     */
    it('opens 1Y on the day before the anniversary, not on useDateRange start', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 12));
      try {
        render(<InvestmentValueChart />);
        await vi.waitFor(() =>
          expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled(),
        );
      } finally {
        vi.useRealTimers();
      }
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2025-08-11' }),
      );
    });
  });

  it('shows the unavailable note on 1d when providers are mixed', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    expect(
      await screen.findByText(/Intraday view unavailable/i),
    ).toBeInTheDocument();
  });

  it('falls back to the daily endpoint on 1w when fallbackToDaily=true', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
  });

  it('shows a background-load indicator when refetching with data already on screen', async () => {
    let resolveDaily: (value: any) => void = () => {};
    vi.mocked(netWorthApi.getInvestmentsDaily).mockImplementationOnce(() =>
      Promise.resolve([
        { date: '2023-06-01', value: 10000 },
        { date: '2024-01-01', value: 15000 },
      ]),
    );
    const { rerender } = render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');

    // Trigger a second load that hangs so we can observe the indicator.
    vi.mocked(netWorthApi.getInvestmentsDaily).mockImplementationOnce(
      () => new Promise((resolve) => { resolveDaily = resolve; }),
    );
    dateRangeState.dateRange = '3m';
    dateRangeState.resolvedRange = { start: '2023-10-01', end: '2024-01-01' };
    rerender(<InvestmentValueChart />);

    const indicator = await screen.findByTestId('chart-loading-indicator');
    expect(indicator).toBeInTheDocument();

    resolveDaily([{ date: '2023-12-01', value: 12000 }]);
    await waitFor(() => {
      expect(screen.queryByTestId('chart-loading-indicator')).toBeNull();
    });
  });

  it('silently falls back to daily on 1w when the intraday request rejects', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(
      new Error('Network error'),
    );
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-12-25', value: 8000 },
      { date: '2024-01-01', value: 9000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('intraday-error-banner')).toBeNull();
    expect(screen.getByText('$9000.00')).toBeInTheDocument();
  });

  it('silently falls back to daily on 1d when the intraday request rejects', async () => {
    dateRangeState.dateRange = '1d';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-02' };
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(
      new Error('500 Internal Server Error'),
    );
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2024-01-01', value: 7777 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('intraday-error-banner')).toBeNull();
  });

  it('shows a warning icon next to the title when 1w falls back to daily', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const warning = await screen.findByTestId('intraday-fallback-warning');
    expect(warning).toBeInTheDocument();
    expect(warning.getAttribute('title')).toContain('VFV.TO');
    expect(warning.getAttribute('title')).toContain('MSN Money');
  });

  it('does not show the warning icon when intraday data is fully available', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.queryByTestId('intraday-fallback-warning')).toBeNull();
  });

  it('clears intraday cache and re-fetches when refresh event fires on 1d', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const initialCalls = vi.mocked(investmentsApi.getIntradayValue).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    });
    await waitFor(() => {
      expect(
        vi.mocked(investmentsApi.getIntradayValue).mock.calls.length,
      ).toBeGreaterThan(initialCalls);
    });
  });

  // Issue #1190. The chart fetches on mount and on a range or currency change,
  // so a write elsewhere on the page -- a cash deposit, a trade -- moved today's
  // point with nothing to tell the chart. `refreshKey` is that signal.
  describe('refreshKey', () => {
    it('re-fetches a daily range when the key is bumped', async () => {
      const { rerender } = render(<InvestmentValueChart refreshKey={0} />);
      await screen.findByText('Portfolio Value Over Time');
      const before = vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length;

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={1} />);
      });

      await waitFor(() => {
        expect(
          vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length,
        ).toBeGreaterThan(before);
      });
    });

    // The intraday series is served from sessionStorage, so a re-fetch that
    // trusted the cache would hand back the pre-write points.
    it('drops the intraday cache and re-fetches when the key is bumped', async () => {
      dateRangeState.dateRange = '1d';
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
        points: [{ timestamp: '2024-01-02T15:00:00.000Z', value: 9000 }],
        interval: '1m',
        currency: 'CAD',
        range: '1d',
        fetchedAt: '2024-01-02T15:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });

      const { rerender } = render(<InvestmentValueChart refreshKey={0} />);
      await screen.findByText('Portfolio Value Over Time');
      await waitFor(() =>
        expect(window.sessionStorage.getItem('monize-intraday|1d||CAD')).toBeTruthy(),
      );
      const before = vi.mocked(investmentsApi.getIntradayValue).mock.calls.length;

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={1} />);
      });

      await waitFor(() => {
        expect(
          vi.mocked(investmentsApi.getIntradayValue).mock.calls.length,
        ).toBeGreaterThan(before);
      });
    });

    // Mounting under a key that is already non-zero is not a write: the initial
    // fetch belongs to the load effect, and firing here as well would double
    // every request the chart makes on an account switch.
    it('does not fetch twice when mounted under a non-zero key', async () => {
      render(<InvestmentValueChart refreshKey={4} />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1),
      );
    });

    // A range change already re-fetches through the load effect. Were the
    // write-refresh effect to depend on the loader it would fetch again for the
    // same change.
    it('does not fetch twice when only the range changes', async () => {
      const { rerender } = render(<InvestmentValueChart refreshKey={2} />);
      await screen.findByText('Portfolio Value Over Time');
      dateRangeState.dateRange = '3m';
      dateRangeState.resolvedRange = { start: '2023-10-01', end: '2024-01-01' };

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={2} titleSuffix="RRSP" />);
      });

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(2),
      );
    });
  });

  it('uses monthly API for 5y range (not in DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '5y';
    dateRangeState.resolvedRange = { start: '2019-01-01', end: '2024-01-01' };
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2019-01-01', value: 1000 },
      { month: '2024-01-01', value: 2000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsMonthly).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('renders titleSuffix when provided', async () => {
    render(<InvestmentValueChart titleSuffix="My Account" />);
    const title = await screen.findByText('Portfolio Value Over Time (My Account)');
    expect(title).toBeInTheDocument();
  });

  it('does not append suffix text when titleSuffix is omitted', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title.textContent).not.toContain('(');
  });

  it('passes displayCurrency to API when it differs from defaultCurrency', async () => {
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ displayCurrency: 'USD' }),
    );
  });

  it('does not pass displayCurrency to API when it matches defaultCurrency', async () => {
    render(<InvestmentValueChart displayCurrency="CAD" />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ displayCurrency: undefined }),
    );
  });

  it('formats values with foreign currency label when displayCurrency differs', async () => {
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    // fmtFull includes the currency code when foreignCurrency is set
    expect(screen.getByText('$15000.00 USD')).toBeInTheDocument();
  });

  it('shows changePercent as 0 when initial value is zero', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 0 },
      { date: '2024-01-01', value: 0 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByText('+0.0%')).toBeInTheDocument();
  });

  it('shows empty chart message with skipped symbols in intradayUnavailable state', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['AAPL', 'MSFT'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const msg = await screen.findByText(/Intraday view unavailable/i);
    expect(msg).toBeInTheDocument();
    // skipped symbols list should appear in the description
    expect(screen.getByText(/AAPL, MSFT/)).toBeInTheDocument();
  });

  it('shows empty chart message without symbol list when skippedSymbols is empty', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const msg = await screen.findByText(/Intraday view unavailable/i);
    expect(msg).toBeInTheDocument();
    expect(screen.queryByText(/:/)).not.toBeInTheDocument();
  });

  it('shows warning icon with empty skippedSymbols in fallback notice', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const warning = await screen.findByTestId('intraday-fallback-warning');
    expect(warning).toBeInTheDocument();
    expect(warning.getAttribute('title')).toContain('one or more holdings');
    // No ticker symbols should appear in the title when skippedSymbols is empty
    expect(warning.getAttribute('title')).not.toMatch(/[A-Z]{2,5}\.[A-Z]{2}/); // e.g. VFV.TO
  });

  it('does not re-fetch on refresh event when range is not intraday', async () => {
    // 1y is a daily range; refresh event should be ignored
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const callCount = vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    });
    // No extra calls triggered
    expect(vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length).toBe(callCount);
  });

  it('hydrates chart from intraday cache on 1d before network resolves', async () => {
    dateRangeState.dateRange = '1d';
    const cachedPayload = {
      fetchedAt: Date.now(),
      points: [{ timestamp: '2024-01-02T14:00:00.000Z', value: 8000 }],
      interval: '1m' as const,
      currency: 'CAD',
      fallbackToDaily: false,
      skippedSymbols: [],
      failedSymbols: [],
    };
    // Seed the session-storage cache manually
    window.sessionStorage.setItem(
      `monize-intraday|1d||CAD`,
      JSON.stringify(cachedPayload),
    );

    // Delay the network response so cache hydration can be observed
    let resolveIntraday!: (v: any) => void;
    vi.mocked(investmentsApi.getIntradayValue).mockImplementationOnce(
      () => new Promise((res) => { resolveIntraday = res; }),
    );

    render(<InvestmentValueChart />);
    // The chart should appear (not stuck on loading skeleton) because of cache
    await screen.findByText('Portfolio Value Over Time');

    // Clean up: resolve the pending network call inside act to avoid state-update warnings
    await act(async () => {
      resolveIntraday({
        points: [{ timestamp: '2024-01-02T14:00:00.000Z', value: 8000 }],
        interval: '1m',
        currency: 'CAD',
        range: '1d',
        fetchedAt: '2024-01-02T15:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });
    });
    window.sessionStorage.clear();
  });

  it('handles intraday API error gracefully and shows empty chart', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(new Error('Network error'));
    // On intraday error the component falls back to daily; mock daily empty so chart stays empty
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('uses monthly API for all range', async () => {
    dateRangeState.dateRange = 'all';
    dateRangeState.resolvedRange = { start: '2010-01-01', end: '2024-01-01' };
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2010-01-01', value: 500 },
      { month: '2024-01-01', value: 3000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsMonthly).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('passes displayCurrency to intraday API when it differs from defaultCurrency', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '1m',
      currency: 'USD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
      expect.objectContaining({ displayCurrency: 'USD' }),
    );
  });

  it('uses daily format labels for intraday 1d range', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-02T15:30:00.000Z', value: 9600 },
      ],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T16:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    // The title renders once data loads; chart renders without crashing
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('uses week format labels for intraday 1w range', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-26', end: '2024-01-02' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2023-12-26T09:30:00.000Z', value: 9400 },
        { timestamp: '2023-12-27T09:30:00.000Z', value: 9500 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T16:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });
});
