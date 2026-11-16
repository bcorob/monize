import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { useLogicalAccounts } from './useLogicalAccounts';
import { Account } from '@/types/account';
import { PortfolioSummary } from '@/types/investment';

const brokerage = {
  id: 'brok',
  name: 'TFSA - Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  linkedAccountId: 'cash',
  currencyCode: 'CAD',
  currentBalance: 0,
  isClosed: false,
} as Account;

const cash = {
  id: 'cash',
  name: 'TFSA - Cash',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_CASH',
  linkedAccountId: 'brok',
  currencyCode: 'CAD',
  currentBalance: 3500,
  isClosed: false,
} as Account;

const summary = {
  holdingsByAccount: [
    { accountId: 'brok', totalMarketValue: 12000, unpricedHoldingsCount: 0 },
  ],
} as PortfolioSummary;

describe('useLogicalAccounts', () => {
  it('folds a pair and strips the localized suffix', () => {
    const { result } = renderHook(
      () => useLogicalAccounts([brokerage, cash], summary),
          );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].displayName).toBe('TFSA');
    expect(result.current[0].combinedValue).toBe(15500);
  });

  // A portfolio request that has not answered (or failed) must not be read as a
  // portfolio worth nothing -- the account's value is unknown until it lands.
  it('leaves the combined value unknown while there is no portfolio summary', () => {
    const { result } = renderHook(
      () => useLogicalAccounts([brokerage, cash], null),
          );

    expect(result.current[0].combinedValue).toBeNull();
  });

  it('keeps the same array identity while its inputs are unchanged', () => {
    const accounts = [brokerage, cash];
    const { result, rerender } = renderHook(
      () => useLogicalAccounts(accounts, summary),
          );
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
