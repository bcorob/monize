import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondBreakdownCard } from './SecurityBondBreakdownCard';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type {
  BondValuation,
  OfferSeries,
  SecurityBondValuation,
} from '@/types/bond';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'PLN',
    }),
  };
});
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2027-04-15',
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityBondValuation: vi.fn(),
    getBondOffer: vi.fn(),
  },
}));

const security = {
  id: 'sec-1',
  symbol: 'EDO',
  name: 'EDO',
  currencyCode: 'PLN',
  bondProgramId: 'prog-1',
} as Security;

const get = vi.mocked(investmentsApi.getSecurityBondValuation);
const getOffer = vi.mocked(investmentsApi.getBondOffer);

function lotValuation(
  seriesCode: string,
  maturityDate: string,
  grossValue: string | null,
): BondValuation {
  return {
    asOf: '2027-04-15',
    status: 'OPEN',
    refusal: null,
    seriesCode,
    termsVersion: 1,
    quantity: 10,
    maturityDate,
    currentPeriod: null,
    rateRule: {
      type: 'BENCHMARK_PLUS_SPREAD',
      benchmarkId: 'PL_CPI_GUS_YOY',
      annualRate: null,
      firstPeriodRate: '0.0560',
      addend: '0.0200',
      benchmarkFloor: null,
    },
    rateSchedule: [],
    principal: '100.0000',
    accruedInterest: null,
    grossValue,
    earlyRedemptionValue: null,
    earlyRedemptionRefusal: null,
    knownCashflows: [],
    projectedCashflows: [],
    nextPayment: [],
    nextRateReset: null,
    nextCapitalization: null,
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    dataCompleteness: {
      termsComplete: true,
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    projectionMissing: [],
    valuationComplete: grossValue !== null,
  };
}

/** Each entry is one lot of its own series: [series code, maturity, gross value]. */
function response(
  lots: Array<[string, string, string | null]>,
): SecurityBondValuation {
  return {
    securityId: 'sec-1',
    program: {
      id: 'prog-1',
      programCode: 'EDO',
      issuerCountryCode: 'PL',
      issuerCode: 'PL_MF',
      currency: 'PLN',
    },
    autoFetch: false,
    asOf: '2027-04-15',
    series: [],
    lots: lots.map(([code, maturity, gross]) => ({
      instrumentId: `id-${code}`,
      purchaseDate: '2026-10-05',
      quantity: 10,
      purchaseDateAssumed: false,
      valuation: lotValuation(code, maturity, gross),
    })),
    totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
    refusal: null,
  };
}

const offerSeries = {
  instrumentId: 'offer-1',
  issuerCountryCode: 'PL',
  issuerCode: 'PL_MF',
  programCode: 'EDO',
  seriesCode: 'EDO0537',
  currency: 'PLN',
  saleWindow: { from: '2027-04-01', to: '2027-04-30' },
  periodMonths: 12,
  periodCount: 10,
  lengthDays: null,
  rateRule: {
    type: 'INFLATION_PLUS_MARGIN_AS_RATE',
    benchmarkId: 'PL_CPI_GUS_YOY',
    annualRate: null,
    firstPeriodRate: '0.0560',
    addend: '0.0200',
    benchmarkFloor: '0',
  },
  capitalization: 'COMPOUND_AT_PERIOD_END',
  redemption: null,
  termsSource: { provider: 'curated', url: '', document: '' },
  projection: {
    maturityValue: null,
    totalReturn: null,
    annualizedReturn: null,
    projected: false,
    assumptions: [],
    projectionMissing: [],
  },
} as OfferSeries;

async function mount() {
  await act(async () => {
    render(<SecurityBondBreakdownCard security={security} />);
  });
}

describe('SecurityBondBreakdownCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOffer.mockResolvedValue({ countryCode: 'PL', today: '2027-04-15', series: [offerSeries] });
    get.mockResolvedValue(
      response([
        ['EDO0536', '2036-05-01', '3000.0000'],
        ['EDO0537', '2037-05-01', '1000.0000'],
        ['EDO1136', '2036-11-01', '1000.0000'],
      ]),
    );
  });

  it('asks for the valuation on the financial today', async () => {
    await mount();
    expect(get).toHaveBeenCalledWith('sec-1', '2027-04-15');
  });

  it('lists one row per series with its value and its share, largest first', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: 'Series' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('$3,000.00 (60.00%)')).toBeInTheDocument();
    expect(screen.getAllByText('$1,000.00 (20.00%)')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'EDO0536: 60.00%' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('groups the maturity tab by year, oldest first, summing the series of a year', async () => {
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Maturity' }));
    const panel = screen.getByRole('tabpanel');
    const labels = within(panel)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent);
    expect(labels).toEqual(['2036', '2037']);
    // 3000 + 1000 in 2036, 1000 in 2037.
    expect(within(panel).getByText('$4,000.00 (80.00%)')).toBeInTheDocument();
    expect(within(panel).getByText('$1,000.00 (20.00%)')).toBeInTheDocument();
  });

  it('shows no share over an incomplete total and says some values are unknown', async () => {
    get.mockResolvedValue(
      response([
        ['EDO0536', '2036-05-01', '3000.0000'],
        ['EDO0537', '2037-05-01', null],
      ]),
    );
    await mount();
    expect(screen.getByText('$3,000.00')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(
      screen.getByText('Some values are unknown, so no shares are shown.'),
    ).toBeInTheDocument();
  });

  it('shows the same note for a maturity year holding an unknown series', async () => {
    get.mockResolvedValue(
      response([
        ['EDO0536', '2036-05-01', '3000.0000'],
        ['EDO1136', '2036-11-01', null],
      ]),
    );
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Maturity' }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Unknown')).toBeInTheDocument();
    expect(within(panel).getByRole('note')).toBeInTheDocument();
  });

  it('shows the facts of the bond kind', async () => {
    await mount();
    expect(screen.getByText('Issuer country')).toBeInTheDocument();
    expect(screen.getByText('Poland')).toBeInTheDocument();
    expect(screen.getByText('Inflation-indexed (benchmark + margin)')).toBeInTheDocument();
    expect(screen.getByText('Interest')).toBeInTheDocument();
    expect(screen.getByText('Compounded at each period end, period: 12 months')).toBeInTheDocument();
    expect(screen.getByText('120 months')).toBeInTheDocument();
  });

  it('labels a zero-coupon discount rule and says it as a discount to face value', async () => {
    getOffer.mockResolvedValue({
      countryCode: 'PL',
      today: '2027-04-15',
      series: [
        {
          ...offerSeries,
          rateRule: {
            type: 'ZERO_COUPON_DISCOUNT',
            benchmarkId: null,
            annualRate: null,
            firstPeriodRate: null,
            addend: null,
            benchmarkFloor: null,
          },
        } as OfferSeries,
      ],
    });
    await mount();
    expect(screen.getByText('Zero-coupon (discount)')).toBeInTheDocument();
    expect(screen.getByText('Discount to face value')).toBeInTheDocument();
  });

  it('says so, and still shows the facts, when no series is held', async () => {
    get.mockResolvedValue(response([]));
    await mount();
    expect(screen.getByText('You hold no series of this bond kind yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Maturity' }));
    expect(screen.getByText('You hold no series of this bond kind yet.')).toBeInTheDocument();
    expect(screen.getByText('Issuer country')).toBeInTheDocument();
    expect(screen.getByText('120 months')).toBeInTheDocument();
  });

  it('names what it cannot tell when the offer cannot be read and nothing is held', async () => {
    get.mockResolvedValue(response([]));
    getOffer.mockRejectedValue(new Error('down'));
    await mount();
    expect(screen.getByText('Issuer country')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
  });

  it('shows a failed valuation as an error, not as an empty holding', async () => {
    get.mockRejectedValue(new Error('boom'));
    await mount();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('You hold no series of this bond kind yet.')).toBeNull();
  });
});
