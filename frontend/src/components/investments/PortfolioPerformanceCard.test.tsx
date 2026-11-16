import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { PortfolioPerformanceCard } from './PortfolioPerformanceCard';
import { netWorthApi } from '@/lib/net-worth';
import type {
  PortfolioPeriodResult,
  PortfolioPeriodResults,
} from '@/types/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsPeriodResults: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'USD',
    }),
  };
});

/**
 * One period as the server sends it -- BOTH measures. Unless a case states
 * otherwise the invested figures mirror the account-level ones, so a case that
 * cares which the card reads (the ones below that set `investmentPnl` or
 * `investmentReturnPercent` on their own) says so out loud.
 */
function period(
  overrides: Partial<PortfolioPeriodResult> = {},
): PortfolioPeriodResult {
  const base: PortfolioPeriodResult = {
    currency: 'USD',
    startDate: '2026-08-18',
    endDate: '2026-09-17',
    startValue: 10000,
    endValue: 10200,
    valueChange: 200,
    netExternalFlows: 0,
    knownFlowSubtotal: 0,
    investmentResult: 200,
    returnPercent: 2,
    returnMethod: 'simple',
    complete: true,
    reasons: [],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
    ...overrides,
  };
  return {
    ...base,
    investedValueStart: base.startValue,
    investedValueEnd: base.endValue,
    investmentCapitalFlows: 0,
    investmentIncome: 0,
    investmentPnl: overrides.investmentPnl ?? base.investmentResult,
    investmentReturnPercent:
      overrides.investmentReturnPercent ?? base.returnPercent,
    investmentReturnMethod: 'twr',
    investedComplete: base.complete,
    investedReasons: overrides.investedReasons ?? base.reasons,
  };
}

function results(
  periods: PortfolioPeriodResults['periods'],
  currency = 'USD',
): PortfolioPeriodResults {
  return { currency, asOf: '2026-09-17', periods };
}

const api = vi.mocked(netWorthApi.getInvestmentsPeriodResults);

const everyPreset = () =>
  results({
    '1d': period({ returnPercent: 0.5, investmentResult: 50 }),
    '1w': period({ returnPercent: 1, investmentResult: 100 }),
    '1m': period(),
    '3m': period({ returnPercent: 3, investmentResult: 300 }),
    ytd: period({ returnPercent: 4, investmentResult: 400 }),
    '1y': period({ returnPercent: 5, investmentResult: 500 }),
  });

describe('PortfolioPerformanceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.mockResolvedValue(everyPreset());
  });

  it('reports the trailing periods the server answered', async () => {
    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('Portfolio performance')).toBeInTheDocument(),
    );
    for (const label of ['1D', '1W', '1M', '3M', 'YTD', '1Y']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The long windows are not in this fixture's answer, so they are not rows.
    expect(screen.queryByText('All time')).not.toBeInTheDocument();
    // The percentage is the server's return over the investment result, and the
    // amount beneath it is that result -- never the value change.
    expect(screen.getByText('+2.00%')).toBeInTheDocument();
    expect(screen.getByText('+$200.00')).toBeInTheDocument();
  });

  // The Investments page asks once for this card and the value chart (#1888).
  it('shows the answer the page hands it without asking again', async () => {
    render(
      <PortfolioPerformanceCard
        periodResults={{ results: everyPreset(), status: 'ready' }}
      />,
    );

    expect(await screen.findByText('+2.00%')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('says what is not in these figures once, under the heading', async () => {
    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(
        screen.getByText(
          'How your investments did, without the effect of deposits, withdrawals and uninvested cash.',
        ),
      ).toBeInTheDocument(),
    );
    // And not a second time beneath the rows: the footnote said the same
    // thing the subtitle already says.
    expect(
      screen.queryByText(/not counted as investment result/),
    ).not.toBeInTheDocument();
  });

  /**
   * The card reports what the INVESTMENTS earned, not what the account did.
   * Here the account-level measure would say +2% on 200 -- it divides by a
   * base holding 2,000 of idle cash -- and the invested measure says +2.5% on
   * the same 200. Reading the wrong pair is the defect (INV-PORTRESULT-002).
   */
  it('reads the invested figures, not the account-level ones', async () => {
    api.mockResolvedValue(
      results({
        '1m': period({
          investmentResult: 200,
          returnPercent: 2,
          investmentPnl: 200,
          investmentReturnPercent: 2.5,
        }),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('+2.50%')).toBeInTheDocument(),
    );
    expect(screen.queryByText('+2.00%')).not.toBeInTheDocument();
  });

  /**
   * A deposit the reader leaves as cash moves the account-level figures and
   * must move neither of these: the card shows the invested zero.
   */
  it('shows zero for a window whose only event was a cash deposit', async () => {
    api.mockResolvedValue(
      results({
        '1m': period({
          valueChange: 50000,
          netExternalFlows: 50000,
          investmentResult: 0,
          returnPercent: 0,
          investmentPnl: 0,
          investmentReturnPercent: 0,
        }),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('+0.00%')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/50,000/)).not.toBeInTheDocument();
  });

  it('says n/a for a period the server withheld', async () => {
    api.mockResolvedValue(
      results({
        '1m': period(),
        '1y': period({
          valueChange: null,
          investmentResult: null,
          returnPercent: null,
          complete: false,
          reasons: ['noValueSeries'],
        }),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('+2.00%')).toBeInTheDocument(),
    );
    // The window is REPORTED and withheld, so it keeps its row and reads
    // "n/a" on both figures: unlike a window the server did not send, there is
    // something here the reader may be able to repair.
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(screen.getAllByText('n/a')).toHaveLength(2);
  });

  /**
   * WHICH windows exist is the server's answer. A five-year return on a
   * two-year-old portfolio is not an "n/a" the reader can act on -- there is
   * nothing to add -- so the server leaves the window out and the card shows
   * the windows it was sent.
   */
  it('shows only the windows the server reported', async () => {
    api.mockResolvedValue(
      results({
        '1d': period(),
        '1w': period(),
        '1m': period(),
        '3m': period(),
        ytd: period(),
        '1y': period(),
        '2y': period(),
        all: period(),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() => expect(screen.getByText('2Y')).toBeInTheDocument());
    expect(screen.getByText('All time')).toBeInTheDocument();
    // The history does not reach five or ten years back, so the server sent
    // neither window and neither has a row -- not even one saying "n/a".
    expect(screen.queryByText('5Y')).not.toBeInTheDocument();
    expect(screen.queryByText('10Y')).not.toBeInTheDocument();
  });

  it('reports every long window a portfolio with the history for it has', async () => {
    api.mockResolvedValue(
      results({
        '1d': period(),
        '1w': period(),
        '1m': period(),
        '3m': period(),
        ytd: period(),
        '1y': period(),
        '2y': period({ returnPercent: 20, investmentResult: 2000 }),
        '5y': period({ returnPercent: 50, investmentResult: 5000 }),
        '10y': period({ returnPercent: 90, investmentResult: 9000 }),
        all: period({ returnPercent: 120, investmentResult: 12000 }),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() => expect(screen.getByText('10Y')).toBeInTheDocument());
    for (const label of ['1D', '1W', '1M', '3M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'All time']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Each long window carries its own figures, in the order the server's
    // preset list gives them.
    expect(screen.getByText('+90.00%')).toBeInTheDocument();
    expect(screen.getByText('+$12,000.00')).toBeInTheDocument();
  });

  it('renders a period that earned nothing as a zero, not as n/a', async () => {
    api.mockResolvedValue(
      results({ '1m': period({ returnPercent: 0, investmentResult: 0 }) }),
    );

    render(<PortfolioPerformanceCard />);

    // A period that earned nothing is a measurement: "+0.00%", not "n/a".
    await waitFor(() => expect(screen.getByText('+0.00%')).toBeInTheDocument());
    expect(screen.getByText('+$0.00')).toBeInTheDocument();
  });

  it('shows a loss with its sign', async () => {
    api.mockResolvedValue(
      results({ '1m': period({ returnPercent: -1.5, investmentResult: -150 }) }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() => expect(screen.getByText('-1.50%')).toBeInTheDocument());
    // The formatter carries the minus; the card adds a plus only to a gain.
    expect(screen.getByText('$-150.00')).toBeInTheDocument();
  });

  /** A request that never answered is not a portfolio that earned nothing. */
  it('names a failed request under six unknown rows, never the empty state', async () => {
    api.mockRejectedValue(new Error('nope'));

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(
        screen.getByText(
          'The period results could not be loaded. The figures are withheld, not zero; reload the page to ask again.',
        ),
      ).toBeInTheDocument(),
    );
    // The regression: a failed request used to fall to "not enough history",
    // which is a claim about the portfolio the card had no grounds for.
    expect(
      screen.queryByText('Not enough history to measure a return yet.'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('n/a').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText('+0.00%')).not.toBeInTheDocument();
  });

  it('names the cause when every period is withheld for a repairable reason', async () => {
    // A portfolio held for months whose first day in every window carries an
    // unpriced holding: the server withholds all six, and the reader must be
    // sent to the price, not told the history is too short.
    const withheld = period({
      valueChange: null,
      investmentResult: null,
      returnPercent: null,
      complete: false,
      reasons: ['incompletePrices', 'missingRatePairs'],
    });
    api.mockResolvedValue(
      results({
        '1d': withheld,
        '1w': withheld,
        '1m': withheld,
        '3m': withheld,
        ytd: withheld,
        '1y': withheld,
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "A withheld period starts on a day a holding had no price. Refresh prices, or add one on the security's price history.",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText('Not enough history to measure a return yet.'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('n/a').length).toBeGreaterThanOrEqual(6);
  });

  it('falls to the empty state only when no window has a valued day', async () => {
    const boundary = period({
      valueChange: null,
      investmentResult: null,
      returnPercent: null,
      complete: false,
      reasons: ['noValueSeries'],
    });
    api.mockResolvedValue(
      results({
        '1d': boundary,
        '1w': boundary,
        '1m': boundary,
        '3m': boundary,
        ytd: boundary,
        '1y': boundary,
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(
        screen.getByText('Not enough history to measure a return yet.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('n/a')).not.toBeInTheDocument();
  });

  it('still names a cause when only some periods are withheld for it', async () => {
    api.mockResolvedValue(
      results({
        '1m': period(),
        '1y': period({
          valueChange: null,
          investmentResult: null,
          returnPercent: null,
          complete: false,
          reasons: ['missingRatePairs'],
        }),
      }),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('+2.00%')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        'A withheld period needs an exchange rate the stored history does not have. Add rate history for the currency on the Currencies page.',
      ),
    ).toBeInTheDocument();
  });

  it('asks again when the page reports a write', async () => {
    const { rerender } = render(<PortfolioPerformanceCard reloadKey={0} />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    rerender(<PortfolioPerformanceCard reloadKey={1} />);

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });

  /**
   * A figure reported in a currency that is not the reader's own says so, the
   * same way the chart's cards do: nobody should read it as their money.
   */
  it("names a reporting currency that is not the reader's own", async () => {
    api.mockResolvedValue(
      results({ '1m': period({ currency: 'CAD' }) }, 'CAD'),
    );

    render(<PortfolioPerformanceCard />);

    await waitFor(() =>
      expect(screen.getByText('+$200.00 CAD')).toBeInTheDocument(),
    );
  });

  it('carries the page filter and currency to the server', async () => {
    render(
      <PortfolioPerformanceCard
        accountIds={['acc-1', 'acc-2']}
        displayCurrency="CAD"
      />,
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith({
        periods: '1d,1w,1m,3m,ytd,1y,2y,5y,10y,all',
        accountIds: 'acc-1,acc-2',
        displayCurrency: 'CAD',
      }),
    );
  });
});
