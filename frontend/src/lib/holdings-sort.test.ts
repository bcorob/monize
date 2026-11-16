import { describe, it, expect } from 'vitest';
import type { AccountHoldings, HoldingWithMarketValue } from '@/types/investment';
import {
  DEFAULT_HOLDINGS_SORT,
  holdingGainLossInAccountCurrency,
  holdingMarketValueInAccountCurrency,
  holdingMarketValueInDefaultCurrency,
  resolveHoldingsSort,
  sortAccountsByName,
  sortHoldings,
  type HoldingsSortField,
} from './holdings-sort';

const holding = (over: Partial<HoldingWithMarketValue>): HoldingWithMarketValue => ({
  id: 'h',
  accountId: 'a',
  securityId: 's',
  symbol: 'AAA',
  name: 'Fund',
  securityType: 'STOCK',
  currencyCode: 'CAD',
  quantity: 1,
  averageCost: 1,
  costBasis: 1,
  costBasisAccountCurrency: 1,
  currentPrice: 1,
  marketValue: 1,
  gainLoss: 0,
  gainLossPercent: 0,
  ...over,
});

const symbols = (rows: HoldingWithMarketValue[]) => rows.map((h) => h.symbol);
const by = (field: HoldingsSortField, direction: 'asc' | 'desc' = 'asc') => ({ field, direction });

describe('holding currency figures', () => {
  it('reads the security value when it is already in the account currency', () => {
    expect(holdingMarketValueInAccountCurrency(holding({ marketValue: 50 }), 'CAD')).toBe(50);
  });

  it("reads the server's converted value for a foreign holding, unknown when absent", () => {
    const usd = holding({ currencyCode: 'USD', marketValue: 100, marketValueAccountCurrency: 135 });
    expect(holdingMarketValueInAccountCurrency(usd, 'CAD')).toBe(135);
    expect(holdingMarketValueInAccountCurrency({ ...usd, marketValueAccountCurrency: undefined }, 'CAD')).toBeNull();
  });

  it('makes the gain unknown when either side is unknown', () => {
    expect(holdingGainLossInAccountCurrency(holding({ marketValue: 50, costBasisAccountCurrency: 30 }), 'CAD')).toBe(20);
    expect(holdingGainLossInAccountCurrency(holding({ marketValue: null }), 'CAD')).toBeNull();
    expect(holdingGainLossInAccountCurrency(holding({ costBasisAccountCurrency: null }), 'CAD')).toBeNull();
  });

  it('reads the default-currency value from the server for a foreign holding', () => {
    expect(holdingMarketValueInDefaultCurrency(holding({ marketValue: 7 }), 'CAD')).toBe(7);
    expect(holdingMarketValueInDefaultCurrency(holding({ currencyCode: 'USD', marketValueDefaultCurrency: 9 }), 'CAD')).toBe(9);
    expect(holdingMarketValueInDefaultCurrency(holding({ currencyCode: 'USD' }), 'CAD')).toBeNull();
  });
});

describe('resolveHoldingsSort', () => {
  const none = new Set<string>();

  it('keeps a valid sort on a visible column', () => {
    expect(resolveHoldingsSort(by('price', 'desc'), none)).toEqual(by('price', 'desc'));
    expect(resolveHoldingsSort(by('symbol'), new Set(['mktValue']))).toEqual(by('symbol'));
  });

  it('falls back to the default while the sorted column is hidden', () => {
    expect(resolveHoldingsSort(by('price'), new Set(['price']))).toEqual(DEFAULT_HOLDINGS_SORT);
  });

  it('falls back to Symbol when Market Value is hidden too', () => {
    expect(resolveHoldingsSort(by('price'), new Set(['price', 'mktValue']))).toEqual(by('symbol'));
    expect(resolveHoldingsSort(DEFAULT_HOLDINGS_SORT, new Set(['mktValue']))).toEqual(by('symbol'));
  });

  it('replaces a stored value that is not a holdings sort', () => {
    expect(resolveHoldingsSort({ field: 'bogus', direction: 'asc' } as never, none)).toEqual(DEFAULT_HOLDINGS_SORT);
    expect(resolveHoldingsSort({ field: 'price', direction: 'up' } as never, none)).toEqual(DEFAULT_HOLDINGS_SORT);
    expect(resolveHoldingsSort(null as never, none)).toEqual(DEFAULT_HOLDINGS_SORT);
  });
});

describe('sortHoldings', () => {
  const rows = [
    holding({ symbol: 'BBB', quantity: 3, averageCost: 5, currentPrice: 20, costBasisAccountCurrency: 300, marketValue: 600 }),
    holding({ symbol: 'aaa', quantity: 1, averageCost: 9, currentPrice: null, costBasisAccountCurrency: 100, marketValue: null }),
    holding({
      symbol: 'CCC', quantity: 2, averageCost: 7, currentPrice: 10, costBasisAccountCurrency: 50,
      currencyCode: 'USD', marketValue: 400, marketValueAccountCurrency: 540, marketValueDefaultCurrency: 540,
    }),
  ];

  it('sorts symbols case-insensitively', () => {
    expect(symbols(sortHoldings(rows, by('symbol'), 'CAD', 'CAD'))).toEqual(['aaa', 'BBB', 'CCC']);
    expect(symbols(sortHoldings(rows, by('symbol', 'desc'), 'CAD', 'CAD'))).toEqual(['CCC', 'BBB', 'aaa']);
  });

  it('sorts the figures the row shows for shares and the per-share columns', () => {
    expect(symbols(sortHoldings(rows, by('shares'), 'CAD', 'CAD'))).toEqual(['aaa', 'CCC', 'BBB']);
    expect(symbols(sortHoldings(rows, by('avgCost', 'desc'), 'CAD', 'CAD'))).toEqual(['aaa', 'CCC', 'BBB']);
    expect(symbols(sortHoldings(rows, by('price'), 'CAD', 'CAD'))).toEqual(['CCC', 'BBB', 'aaa']);
  });

  it('compares money columns in the account currency, unknown last in both directions', () => {
    expect(symbols(sortHoldings(rows, by('mktValue', 'desc'), 'CAD', 'CAD'))).toEqual(['BBB', 'CCC', 'aaa']);
    expect(symbols(sortHoldings(rows, by('mktValue'), 'CAD', 'CAD'))).toEqual(['CCC', 'BBB', 'aaa']);
    expect(symbols(sortHoldings(rows, by('costBasis'), 'CAD', 'CAD'))).toEqual(['CCC', 'aaa', 'BBB']);
    // Gains: BBB 300, CCC 490, aaa unknown.
    expect(symbols(sortHoldings(rows, by('gainLoss', 'desc'), 'CAD', 'CAD'))).toEqual(['CCC', 'BBB', 'aaa']);
  });

  it('ranks a foreign holding by its converted value, not its bare number', () => {
    const usdAccount = sortHoldings(rows, by('mktValue', 'desc'), 'USD', 'CAD');
    // In a USD account the CAD rows have no converted value here, so CCC alone is known.
    expect(symbols(usdAccount)).toEqual(['CCC', 'aaa', 'BBB']);
    expect(symbols(sortHoldings(rows, by('portfolioPercent', 'desc'), 'CAD', 'CAD'))).toEqual(['BBB', 'CCC', 'aaa']);
  });

  it('breaks ties by symbol and leaves the input untouched', () => {
    const tied = [holding({ symbol: 'ZED', quantity: 1 }), holding({ symbol: 'ABC', quantity: 1 })];
    expect(symbols(sortHoldings(tied, by('shares', 'desc'), 'CAD', 'CAD'))).toEqual(['ABC', 'ZED']);
    expect(symbols(tied)).toEqual(['ZED', 'ABC']);
  });
});

describe('sortAccountsByName', () => {
  it('orders accounts alphabetically without mutating the input', () => {
    const accounts = [{ accountName: 'TFSA' }, { accountName: 'brokerage' }, { accountName: 'RRSP' }] as AccountHoldings[];
    expect(sortAccountsByName(accounts).map((a) => a.accountName)).toEqual(['brokerage', 'RRSP', 'TFSA']);
    expect(accounts[0].accountName).toBe('TFSA');
  });
});
