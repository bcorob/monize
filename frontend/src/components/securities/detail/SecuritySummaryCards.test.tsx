import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { FALLBACK_DEFAULT_CURRENCY } from '@/lib/default-currency';

/** Rates the mocked hook reports, keyed `FROM->TO`; a test sets what it needs. */
const mockRates = new Map<string, number>();

/**
 * The reader's own currency, as the COMPONENT resolves it.
 *
 * It reads `defaultCurrency` off `useNumberFormat`, which is not mocked here --
 * so with no preference set that is the shared fallback. This mock used to
 * hardcode `'CAD'` as the conversion target, which agreed with the component
 * only for as long as the fallback happened to be CAD: when the fallback moved
 * to USD, every rate the fixtures registered was keyed on a pair the component
 * no longer asked for, and three cases failed with the component correct.
 *
 * Derived from the same constant the component ends up on, so the two cannot
 * disagree again.
 */
const READER_CURRENCY = FALLBACK_DEFAULT_CURRENCY;

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, from: string) => {
      const rate = mockRates.get(`${from}->${READER_CURRENCY}`);
      // Mirrors the real hook, which returns the amount untouched without a
      // rate -- the behaviour the guard exists to defend against.
      return rate === undefined ? amount : amount * rate;
    },
    getRate: (from: string, to?: string) =>
      from === (to ?? READER_CURRENCY)
        ? 1
        : (mockRates.get(`${from}->${to ?? READER_CURRENCY}`) ?? null),
  }),
}));
import { SecuritySummaryCards } from './SecuritySummaryCards';
import type {
  Security,
  SecurityDetail,
  SecurityDetailAccountPosition,
} from '@/types/investment';

function security(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'IUSQ',
    name: 'All World',
    securityType: 'ETF',
    exchange: 'XETRA',
    currencyCode: 'EUR',
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
    ...overrides,
  };
}

function account(
  overrides: Partial<SecurityDetailAccountPosition> = {},
): SecurityDetailAccountPosition {
  return {
    accountId: 'acct-1',
    accountName: 'Brokerage',
    accountCurrencyCode: 'PLN',
    isClosed: false,
    quantity: 60,
    averageCost: 100,
    costBasis: 6000,
    costBasisAccountCurrency: 24000,
    marketValue: 7200,
    gainLoss: 1200,
    gainLossPercent: 20,
    ...overrides,
  };
}

function detail(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security: security(),
    position: {
      quantity: 100,
      averageCost: 120,
      currentPrice: 150,
      costBasis: 12000,
      marketValue: 15000,
      gainLoss: 3000,
      gainLossPercent: 25,
    },
    accounts: [account(), account({ accountId: 'acct-2', accountName: 'IKE', quantity: 40 })],
    activity: {
      firstTransactionDate: '2022-03-12',
      lastTransactionDate: '2026-06-20',
      totalInvested: 12000,
      totalSold: 0,
      dividends: 0,
      fees: 0,
      realizedGain: null,
      realizedGainCurrency: null,
      realizedGainCurrencies: [],
      realizedSaleCount: 0,
      transactionCount: 4,
    },
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockRates.clear();
});

describe('SecuritySummaryCards', () => {
  it('shows the five figures in the security currency', () => {
    render(<SecuritySummaryCards detail={detail()} />);
    // The fixture is a EUR security and the test default is USD, so each figure
    // carries its code -- see the foreign-currency tests below.
    expect(screen.getByText('€15,000.00 EUR')).toBeInTheDocument();
    expect(screen.getByText('€12,000.00 EUR')).toBeInTheDocument();
    expect(screen.getByText('+€3,000.00 EUR')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });

  describe('a currency that is not the reader s own', () => {
    it('names the currency on every money figure', () => {
      render(<SecuritySummaryCards detail={detail()} />);
      // Nothing on this page is converted, and a symbol does not identify a
      // currency: "$" is four of them. Same marking the Investments page uses.
      expect(screen.getByText('€15,000.00 EUR')).toBeInTheDocument();
      expect(screen.getByText('€120.00 EUR')).toBeInTheDocument();
    });

    it('leaves the code off when it is the reader s own currency', () => {
      // The test preferences set none, so the reader is on the shared fallback.
      // Named through the constant rather than spelled out: a fixture that
      // hardcodes the currency it means by "the reader's own" stops meaning that
      // the moment the fallback changes.
      render(
        <SecuritySummaryCards
          detail={{
            ...detail({
              security: security({ currencyCode: READER_CURRENCY }),
            }),
          }}
        />,
      );
      // Repeating the code beside every figure on the reader's own screen is
      // noise, not information.
      expect(screen.getByText('$15,000.00')).toBeInTheDocument();
      expect(screen.queryByText(READER_CURRENCY)).not.toBeInTheDocument();
    });
  });

  describe('the unknown contract', () => {
    // The whole point of the null-vs-zero distinction: a zero market value is a
    // claim about worth, and "we could not price this" is not that claim. These
    // paths are what a holding in a closed account or a filtered dust residual
    // actually renders as, so they are the ones most worth pinning down.
    it('reports an unpriceable position as unknown rather than zero', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 100,
              averageCost: null,
              currentPrice: null,
              costBasis: null,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
          })}
        />,
      );
      // One per figure that could not be computed, and never a 0.00 among them.
      expect(screen.getAllByText('Not priced')).toHaveLength(4);
      expect(screen.queryByText('€0.00')).not.toBeInTheDocument();
    });

    it('drops the percentage when there is no gain to take one of', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 100,
              averageCost: 120,
              currentPrice: null,
              costBasis: 12000,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
          })}
        />,
      );
      expect(screen.queryByText('+0.00%')).not.toBeInTheDocument();
    });

    it('says so when no account holds the security', () => {
      render(<SecuritySummaryCards detail={detail({ accounts: [] })} />);
      expect(
        screen.getByText('This security is not held in any account.'),
      ).toBeInTheDocument();
    });
  });

  describe('dating the market value', () => {
    // The card used to carry an "At the close of {date}" line. Intraday that
    // was simply false -- the newest row is the latest quote, not a close --
    // so the timing moved to the header, which states it to the minute.
    it('does not date the value on the card', () => {
      render(<SecuritySummaryCards detail={detail()} />);
      expect(screen.queryByText(/At the close of/)).not.toBeInTheDocument();
    });
  });

  describe('held in accounts', () => {
    it('gives each account its units and share of the total', () => {
      render(<SecuritySummaryCards detail={detail()} />);
      expect(screen.getByText('60 (60.00%)')).toBeInTheDocument();
      expect(screen.getByText('40 (40.00%)')).toBeInTheDocument();
    });

    it('marks a position left in a closed account', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            accounts: [account({ isClosed: true })],
          })}
        />,
      );
      expect(screen.getByText('Brokerage (closed)')).toBeInTheDocument();
    });

    it('bounds the list with the slim scrollbar so the card keeps its height', () => {
      const { container } = render(
        <SecuritySummaryCards
          detail={detail({
            accounts: Array.from({ length: 10 }, (_, index) =>
              account({
                accountId: `acct-${index}`,
                accountName: `Account ${index}`,
                quantity: 10,
              }),
            ),
          })}
        />,
      );
      // This card sits in a row with five others; growing it drags the whole
      // grid down. The bar stays -- a bounded list needs one -- but it is the
      // slim one, because the native control is what looked broken.
      const list = container.querySelector('ul')!;
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toMatch(/max-h-/);
      expect(list.className).toContain('scrollbar-slim');
      // Every account is still there to scroll to, not cut off.
      expect(list.querySelectorAll('li')).toHaveLength(10);
    });

    it('does not divide by a zero total when the balances cancel out', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 0,
              averageCost: null,
              currentPrice: 150,
              costBasis: null,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
            accounts: [
              account({ quantity: 10 }),
              account({ accountId: 'acct-2', accountName: 'IKE', quantity: -10 }),
            ],
          })}
        />,
      );
      // A share of nothing is 0%, not NaN% or Infinity%.
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
    });
  });
});

describe('SecuritySummaryCards in the reader s own currency', () => {
  // The page holds every figure in the security's currency and converts nothing
  // itself. What a reader on PLN still wants is roughly what it is worth to
  // them, so the cards carry a second line -- but only when a rate exists.
  it('adds the converted figure when a rate for the pair is known', () => {
    mockRates.set(`EUR->${READER_CURRENCY}`, 1.5);
    render(<SecuritySummaryCards detail={detail()} />);

    // 15,000 EUR at 1.5 = 22,500 in the reader's currency.
    expect(screen.getByText(/~\s*\$22,500\.00/)).toBeInTheDocument();
    // ...and the figure itself still reads in the security's own currency.
    expect(screen.getByText('€15,000.00 EUR')).toBeInTheDocument();
  });

  it('converts the cost basis and the gain at the same rate', () => {
    mockRates.set(`EUR->${READER_CURRENCY}`, 1.5);
    render(<SecuritySummaryCards detail={detail()} />);
    // 12,000 -> 18,000 and 3,000 -> 4,500: one rate throughout, so the three
    // converted figures still add up the way the originals do.
    expect(screen.getByText(/~\s*\$18,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/~\s*\$4,500\.00/)).toBeInTheDocument();
  });

  it('shows nothing rather than an unconverted figure under the wrong symbol', () => {
    // `convertToDefault` returns the amount untouched when it has no rate, so a
    // euro figure would print as zlotys. Silence is the honest output.
    mockRates.clear();
    render(<SecuritySummaryCards detail={detail()} />);
    expect(screen.queryByText(/~/)).not.toBeInTheDocument();
  });

  it('adds no second line when the security is already in the reader s currency', () => {
    mockRates.set(`EUR->${READER_CURRENCY}`, 1.5);
    render(
      <SecuritySummaryCards
        detail={detail({ security: security({ currencyCode: READER_CURRENCY }) })}
      />,
    );
    expect(screen.queryByText(/~/)).not.toBeInTheDocument();
  });
});

describe('SecuritySummaryCards held-in-accounts changes', () => {
  it('no longer repeats the total, leaving the row for an account', () => {
    render(<SecuritySummaryCards detail={detail()} />);
    // The Units card beside this one already states it (review of #964).
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('opens the Investments page for an account when asked to', () => {
    const onSelectAccount = vi.fn();
    render(
      <SecuritySummaryCards detail={detail()} onSelectAccount={onSelectAccount} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Brokerage/ }));
    expect(onSelectAccount).toHaveBeenCalledWith('acct-1');
  });

  it('leaves a closed account as plain text', () => {
    // The Investments page lists open accounts, so a link there would land on
    // nothing.
    render(
      <SecuritySummaryCards
        detail={detail({ accounts: [account({ isClosed: true })] })}
        onSelectAccount={vi.fn()}
      />,
    );
    expect(screen.getByText('Brokerage (closed)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Brokerage/ })).toBeNull();
  });

  it('stays read-only without a handler', () => {
    render(<SecuritySummaryCards detail={detail()} />);
    expect(screen.queryByRole('button', { name: /Brokerage/ })).toBeNull();
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
  });
});
