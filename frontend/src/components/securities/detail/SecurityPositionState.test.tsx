import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityPositionState } from './SecurityPositionState';
import type { SecurityDetail } from '@/types/investment';

function detail(overrides: {
  hasTransactions?: boolean;
  activity?: Partial<SecurityDetail['activity']>;
}): SecurityDetail {
  return {
    security: {
      id: 'sec-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      securityType: 'STOCK',
      exchange: 'NASDAQ',
      currencyCode: 'USD',
      description: null,
      tags: [],
      isActive: true,
      isFavourite: false,
      skipPriceUpdates: false,
      sector: null,
      industry: null,
      sectorWeightings: null,
      countryWeightings: null,
      assetWeightings: null,
      website: null,
      irWebsite: null,
      quoteProvider: 'yahoo',
      msnInstrumentId: null,
      lastPriceSource: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    // Nothing is held in either case this panel covers, so every figure is zero.
    // The panel exists precisely so those zeroes are never rendered as a summary.
    position: {
      quantity: 0,
      averageCost: 0,
      currentPrice: 0,
      costBasis: 0,
      marketValue: 0,
      gainLoss: 0,
      gainLossPercent: 0,
    },
    accounts: [],
    activity: {
      firstTransactionDate: '2022-03-12',
      lastTransactionDate: '2025-06-20',
      totalInvested: 5000,
      totalSold: 6000,
      dividends: 0,
      fees: 0,
      realizedGain: 1000,
      realizedGainCurrency: 'USD',
      realizedGainCurrencies: ['USD'],
      realizedSaleCount: 1,
      transactionCount: 2,
      ...overrides.activity,
    },
    hasTransactions: overrides.hasTransactions ?? true,
    isPositionClosed: true,
  } as SecurityDetail;
}

describe('SecurityPositionState', () => {
  it('tells a never-traded security apart from a closed one', () => {
    // Zero-filled cards would claim a value of zero where the truth is "nothing
    // here yet", which is why this panel exists instead.
    render(<SecurityPositionState detail={detail({ hasTransactions: false })} />);

    expect(screen.getByText('No position data')).toBeInTheDocument();
    expect(
      screen.getByText(
        'You have not recorded any transactions for this security yet.',
      ),
    ).toBeInTheDocument();
    // Nothing was ever sold, so there is no realised result to report.
    expect(screen.queryByText('Realized P/L')).not.toBeInTheDocument();
    expect(screen.queryByText('Position closed')).not.toBeInTheDocument();
  });

  it('reports the realised result and the period it was held once closed', () => {
    render(<SecurityPositionState detail={detail({})} />);

    expect(screen.getByText('Position closed')).toBeInTheDocument();
    expect(screen.getByText('Realized P/L')).toBeInTheDocument();
    // A gain carries its sign explicitly: "1,000.00" alone reads as a balance.
    expect(screen.getByText(/\+.*1,000\.00/)).toBeInTheDocument();
    expect(screen.getByText('Held from')).toBeInTheDocument();
  });

  it('omits the realised figure when sales spanned several currencies', () => {
    // The backend sends null rather than adding up two currencies; showing a bare
    // number here would imply a conversion the page never performs.
    render(
      <SecurityPositionState
        detail={detail({
          activity: { realizedGain: null, realizedGainCurrency: null },
        })}
      />,
    );

    expect(screen.getByText('Position closed')).toBeInTheDocument();
    expect(screen.queryByText('Realized P/L')).not.toBeInTheDocument();
    // The held period is independent of currency, so it stays.
    expect(screen.getByText('Held from')).toBeInTheDocument();
  });

  it('shows the known part of an unknown realized gain', () => {
    render(
      <SecurityPositionState
        detail={detail({
          activity: {
            realizedGain: null,
            realizedGainComplete: false,
            realizedGainKnownSubtotal: 300,
          },
        })}
      />,
    );

    expect(screen.getByText('Realized P/L')).toBeInTheDocument();
    expect(screen.getByText(/Known part:.*300\.00/)).toBeInTheDocument();
  });

  it('omits the held period when the dates are unknown', () => {
    render(
      <SecurityPositionState
        detail={detail({
          activity: { firstTransactionDate: null, lastTransactionDate: null },
        })}
      />,
    );

    expect(screen.getByText('Position closed')).toBeInTheDocument();
    expect(screen.queryByText('Held from')).not.toBeInTheDocument();
  });
});
