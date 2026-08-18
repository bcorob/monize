import { describe, it, expect } from 'vitest';
import type { Account } from '@/types/account';
import type { LogicalAccount } from '@/lib/logical-accounts';
import {
  DEFAULT_FILTERS,
  INSTITUTION_NONE,
  groupEntries,
  groupKeyFor,
  institutionKeyFor,
  matchesFilters,
  sortEntries,
  type AccountBalanceFilters,
} from './grouping';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'CAD',
    isClosed: false,
    isFavourite: false,
    institution: null,
    institutionId: null,
    ...overrides,
  } as Account;
}

function entry(acc: Account, combinedValue: number | null = 0): LogicalAccount {
  return {
    id: acc.id,
    primary: acc,
    cash: null,
    memberIds: [acc.id],
    displayName: acc.name,
    isInvestment: acc.accountType === 'INVESTMENT',
    cashRegisterId: acc.id,
    holdingsAccountId: null,
    combinedValue,
  };
}

const filters = (overrides: Partial<AccountBalanceFilters> = {}) => ({
  ...DEFAULT_FILTERS,
  ...overrides,
});

describe('institutionKeyFor', () => {
  it('prefers the structured institution record', () => {
    expect(institutionKeyFor(account({ institutionId: 'inst-1', institution: 'Legacy' }))).toBe(
      'inst-1',
    );
  });

  // An account imported before institutions existed carries only the free-text
  // name; folding it into "no institution" would hide it from its own bank.
  it('falls back to the legacy free-text name', () => {
    expect(institutionKeyFor(account({ institution: 'Old Bank' }))).toBe('name:Old Bank');
  });

  it('reports an account with neither as unfiled', () => {
    expect(institutionKeyFor(account())).toBe(INSTITUTION_NONE);
  });
});

describe('matchesFilters', () => {
  it('splits assets from liabilities by account type', () => {
    const card = account({ accountType: 'CREDIT_CARD' });
    expect(matchesFilters(card, filters({ scope: 'liabilities' }))).toBe(true);
    expect(matchesFilters(card, filters({ scope: 'assets' }))).toBe(false);
    expect(matchesFilters(account(), filters({ scope: 'liabilities' }))).toBe(false);
  });

  it('defaults to open accounts and can ask for closed or both', () => {
    const closed = account({ isClosed: true });
    expect(matchesFilters(closed, filters())).toBe(false);
    expect(matchesFilters(closed, filters({ status: 'closed' }))).toBe(true);
    expect(matchesFilters(closed, filters({ status: 'all' }))).toBe(true);
    expect(matchesFilters(account(), filters({ status: 'closed' }))).toBe(false);
  });

  it('selects favourites or everything else', () => {
    const favourite = account({ isFavourite: true });
    expect(matchesFilters(favourite, filters({ favourite: 'favourites' }))).toBe(true);
    expect(matchesFilters(favourite, filters({ favourite: 'others' }))).toBe(false);
    expect(matchesFilters(account(), filters({ favourite: 'others' }))).toBe(true);
  });

  it('restricts to the chosen account types', () => {
    expect(matchesFilters(account(), filters({ accountTypes: ['SAVINGS'] }))).toBe(false);
    expect(matchesFilters(account(), filters({ accountTypes: ['CHEQUING'] }))).toBe(true);
  });

  it('restricts to the chosen institutions', () => {
    const acc = account({ institutionId: 'inst-1' });
    expect(matchesFilters(acc, filters({ institutionKeys: ['inst-2'] }))).toBe(false);
    expect(matchesFilters(acc, filters({ institutionKeys: ['inst-1'] }))).toBe(true);
  });

  // An untouched multi-select means "no restriction"; reading it as "nothing
  // selected, so show nothing" empties the report the moment it renders.
  it('treats an empty multi-select as no restriction', () => {
    expect(matchesFilters(account(), filters({ accountTypes: [], institutionKeys: [] }))).toBe(
      true,
    );
  });
});

describe('groupKeyFor', () => {
  it.each([
    ['assetLiability', account({ accountType: 'MORTGAGE' }), 'liabilities'],
    ['assetLiability', account(), 'assets'],
    ['type', account({ accountType: 'SAVINGS' }), 'SAVINGS'],
    ['institution', account({ institutionId: 'inst-9' }), 'inst-9'],
    ['status', account({ isClosed: true }), 'closed'],
    ['favourite', account({ isFavourite: true }), 'favourite'],
    ['none', account(), 'all'],
  ] as const)('groups by %s', (groupBy, acc, expected) => {
    expect(groupKeyFor(entry(acc), groupBy)).toBe(expected);
  });
});

describe('groupEntries', () => {
  it('orders assets before liabilities whatever order they arrive in', () => {
    const groups = groupEntries(
      [entry(account({ id: 'a', accountType: 'CREDIT_CARD' })), entry(account({ id: 'b' }))],
      'assetLiability',
    );
    expect(groups.map((g) => g.key)).toEqual(['assets', 'liabilities']);
  });

  it('keeps first-appearance order for groupings with no natural order', () => {
    const groups = groupEntries(
      [
        entry(account({ id: 'a', accountType: 'SAVINGS' })),
        entry(account({ id: 'b', accountType: 'CHEQUING' })),
        entry(account({ id: 'c', accountType: 'SAVINGS' })),
      ],
      'type',
    );
    expect(groups.map((g) => g.key)).toEqual(['SAVINGS', 'CHEQUING']);
    expect(groups[0].entries).toHaveLength(2);
  });
});

describe('sortEntries', () => {
  const a = entry(account({ id: 'a', name: 'Alpha' }), 10);
  const b = entry(account({ id: 'b', name: 'Beta' }), 30);
  const unknown = entry(account({ id: 'c', name: 'Gamma' }), null);
  const value = (e: LogicalAccount) => e.combinedValue;

  it('sorts by name in both directions', () => {
    expect(sortEntries([b, a], 'name', 'asc', value).map((e) => e.displayName)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(sortEntries([a, b], 'name', 'desc', value).map((e) => e.displayName)).toEqual([
      'Beta',
      'Alpha',
    ]);
  });

  it('sorts by balance in both directions', () => {
    expect(sortEntries([a, b], 'balance', 'desc', value).map((e) => e.displayName)).toEqual([
      'Beta',
      'Alpha',
    ]);
    expect(sortEntries([b, a], 'balance', 'asc', value).map((e) => e.displayName)).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  // Scoring an unknown balance as zero puts it among the small ones, where it
  // reads as a small balance rather than as no answer.
  it('puts an unknown balance last in both directions', () => {
    expect(
      sortEntries([unknown, a, b], 'balance', 'desc', value).map((e) => e.displayName),
    ).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(
      sortEntries([unknown, b, a], 'balance', 'asc', value).map((e) => e.displayName),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('breaks a tie on the name so the order is stable', () => {
    const tie = entry(account({ id: 'd', name: 'Aardvark' }), 10);
    expect(sortEntries([a, tie], 'balance', 'desc', value).map((e) => e.displayName)).toEqual([
      'Aardvark',
      'Alpha',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [b, a];
    sortEntries(input, 'name', 'asc', value);
    expect(input.map((e) => e.displayName)).toEqual(['Beta', 'Alpha']);
  });
});
