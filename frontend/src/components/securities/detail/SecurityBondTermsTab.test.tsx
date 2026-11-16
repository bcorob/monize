import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondTermsTab } from './SecurityBondTermsTab';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'PLN',
      formatCurrencyAxis: (value: number) => `${value}`,
    }),
  };
});
vi.mock('@/hooks/useFinancialToday', () => ({ useFinancialToday: () => '2027-04-15' }));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurityBondValuation: vi.fn(), getBondHistory: vi.fn() },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: ({ name }: any) => <i data-testid="line" data-name={name} />,
  ReferenceDot: ({ x }: any) => <i data-testid="held-dot" data-x={x} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: () => null,
}));

const security = { id: 'sec-1', currencyCode: 'PLN', bondProgramId: 'prog-1' } as Security;
const getValuation = vi.mocked(investmentsApi.getSecurityBondValuation);
const getHistory = vi.mocked(investmentsApi.getBondHistory);

const source = { document: 'Terms', url: null };
const history = {
  countryCode: 'PL',
  programs: [
    {
      programCode: 'RETAIL',
      coverage: { from: '2026-09', to: '2026-12', missingMonths: ['2026-11'] },
      series: [
        ['TOS1026', '2026-10-01'],
        ['TOS0926', '2026-09-01'],
        ['TOS1225', '2025-12-01'],
      ].map(([seriesCode, from]) => ({
        seriesCode,
        saleWindow: { from, to: from },
        firstPeriodRate: '0.0440',
        annualRate: null,
        addend: null,
        fee: '3.00',
        proceedsFloor: null,
        termsVersion: 1,
        termsSource: source,
      })),
    },
  ],
};

const valuation = {
  securityId: 'sec-1',
  program: { id: 'prog-1', programCode: 'RETAIL', issuerCountryCode: 'PL', issuerCode: 'PL_MF', currency: 'PLN' },
  autoFetch: false,
  series: [{ instrumentId: 'b1', seriesCode: 'TOS1026', programCode: 'RETAIL', redemptionTerms: null }],
  asOf: '2027-04-15',
  lots: [
    {
      instrumentId: 'b1',
      purchaseDate: '2026-10-05',
      quantity: 1,
      purchaseDateAssumed: false,
      valuation: { seriesCode: 'TOS1026' },
    },
  ],
  totals: { quantity: 1, grossValue: '1', earlyRedemptionValue: '1', accruedInterest: '0' },
  refusal: null,
} as any;

async function mount(refreshVersion = 0) {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<SecurityBondTermsTab security={security} refreshVersion={refreshVersion} />);
  });
  return utils;
}

describe('SecurityBondTermsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValuation.mockResolvedValue(valuation);
    getHistory.mockResolvedValue(history as any);
  });

  it('draws both charts, the gaps note, the missing months and the grouped table', async () => {
    await mount();
    const region = screen.getByRole('region', { name: 'History of RETAIL terms' });
    expect(within(region).getAllByTestId('line-chart')).toHaveLength(2);
    expect(within(region).getByText('First-period rate and margin by sale month')).toBeInTheDocument();
    expect(within(region).getByText('Early redemption fee by sale month')).toBeInTheDocument();
    expect(within(region).getByText(/never a value drawn from its neighbours/)).toBeInTheDocument();
    expect(within(region).getByText('Months missing from the catalog (1)')).toBeInTheDocument();
    expect(within(region).getByText('Every stored series')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: /2026/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(region).getByRole('button', { name: /2025/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads the history for the program\'s own country', async () => {
    getValuation.mockResolvedValue({
      ...valuation,
      program: { ...valuation.program, issuerCountryCode: 'US' },
    });
    await mount();
    expect(getHistory).toHaveBeenCalledWith('US', 'RETAIL');
    expect(getHistory).not.toHaveBeenCalledWith('PL', expect.anything());
  });

  it('marks the series the reader holds', async () => {
    await mount();
    const dots = screen.getAllByTestId('held-dot');
    expect(dots.map((d) => d.getAttribute('data-x'))).toEqual(['2026-10']);
    const row = screen.getByText('TOS1026').closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('aria-current', 'true');
  });

  it('re-reads the history when the refresh counter changes', async () => {
    const { rerender } = await mount();
    const before = getHistory.mock.calls.length;
    await act(async () => {
      rerender(<SecurityBondTermsTab security={security} refreshVersion={1} />);
    });
    expect(getHistory.mock.calls.length).toBeGreaterThan(before);
    expect(getValuation).toHaveBeenCalledTimes(2);
  });

  it('says the valuation could not be read and offers a retry', async () => {
    getValuation.mockRejectedValue(new Error('boom'));
    await mount();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
