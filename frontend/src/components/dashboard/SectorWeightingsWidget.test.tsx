import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { SectorWeightingsWidget } from './SectorWeightingsWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

// Stable config reference across renders (mirrors the real memoized hook), so
// useReportData's [config.accountIds] dependency does not change every render.
const { widgetCfg } = vi.hoisted(() => ({
  widgetCfg: { config: { accountIds: [] as string[] }, updateConfig: () => {} },
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => widgetCfg,
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'USD' }),
}));

const getSectorWeightings = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSectorWeightings: (...a: unknown[]) => getSectorWeightings(...a) },
}));

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

async function renderWidget() {
  await act(async () => {
    render(<SectorWeightingsWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('SectorWeightingsWidget', () => {
  beforeEach(() => getSectorWeightings.mockReset());

  it('renders a stacked bar for sector weightings', async () => {
    getSectorWeightings.mockResolvedValue({
      items: [
        { sector: 'Technology', directValue: 600, etfValue: 400, totalValue: 1000, percentage: 60 },
        { sector: 'Energy', directValue: 300, etfValue: 100, totalValue: 400, percentage: 40 },
      ],
      totalPortfolioValue: 1400,
      totalDirectValue: 900,
      totalEtfValue: 500,
      unclassifiedValue: 0,
    });
    await renderWidget();
    expect(screen.getByText('Sector Allocation')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('names what is left out while the valuation is partial', async () => {
    const base = {
      items: [{ sector: 'Technology', directValue: 600, etfValue: 0, totalValue: 600, percentage: 100 }],
      totalDirectValue: 600,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    };
    getSectorWeightings.mockResolvedValue({
      ...base,
      totalPortfolioValue: null,
      knownSubtotal: 600,
      valuationComplete: false,
      unpricedSymbols: ['NOP'],
      missingRatePairs: [],
    });
    await renderWidget();
    expect(screen.getByTestId('weighting-partial-note').textContent).toContain('NOP');
  });

  it('shows no partial note when the valuation is complete', async () => {
    getSectorWeightings.mockResolvedValue({
      items: [{ sector: 'Technology', directValue: 600, etfValue: 0, totalValue: 600, percentage: 100 }],
      totalPortfolioValue: 600,
      knownSubtotal: 600,
      valuationComplete: true,
      totalDirectValue: 600,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    await renderWidget();
    expect(screen.queryByTestId('weighting-partial-note')).not.toBeInTheDocument();
  });

  it('shows the empty state with no sectors', async () => {
    getSectorWeightings.mockResolvedValue({
      items: [],
      totalPortfolioValue: 0,
      totalDirectValue: 0,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    await renderWidget();
    expect(screen.getByText('No sector data available.')).toBeInTheDocument();
  });
});
