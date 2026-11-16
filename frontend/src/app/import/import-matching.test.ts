import { describe, it, expect } from 'vitest';
import {
  buildSecurityMappings,
  getCategoryPath,
  findMatchingCategory,
  findMatchingLoanAccount,
  matchFilenameToAccount,
  buildCategoryMappings,
  buildAccountMappings,
  findMatchingSecurityBySymbol,
} from './import-matching';
import { Security } from '@/types/investment';
import { Category } from '@/types/category';
import { Account } from '@/types/account';

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'c-1',
    name: 'Food',
    parentId: null,
    color: null,
    icon: null,
    isIncome: false,
    sortOrder: 0,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as Category;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a-1',
    name: 'Checking',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'USD',
    institution: null, institutionId: null,
    accountNumber: null,
    notes: null,
    currentBalance: 0,
    isClosed: false,
    isFavourite: false,
    sortOrder: 0,
    linkedAccountId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as Account;
}

function makeSecurity(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    exchange: 'NASDAQ',
    currencyCode: 'USD',
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
    quoteProvider: null,
    msnInstrumentId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

describe('buildSecurityMappings', () => {
  it('matches existing security by symbol', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.' })];
    const result = buildSecurityMappings(new Set(['AAPL']), securities, 'USD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBe('sec-1');
    expect(result[0].currencyCode).toBeUndefined();
  });

  it('matches existing security by name (case-insensitive)', () => {
    const securities = [makeSecurity({ id: 'sec-2', symbol: 'GOOG', name: 'Alphabet Inc.' })];
    const result = buildSecurityMappings(new Set(['alphabet inc.']), securities, 'USD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBe('sec-2');
  });

  it('sets defaultCurrency for unmatched securities', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL' })];
    const result = buildSecurityMappings(new Set(['MSFT']), securities, 'CAD');

    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBeUndefined();
    expect(result[0].currencyCode).toBe('CAD');
  });

  it('does not set currencyCode when security is matched', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL' })];
    const result = buildSecurityMappings(new Set(['AAPL']), securities, 'EUR');

    expect(result[0].securityId).toBe('sec-1');
    expect(result[0].currencyCode).toBeUndefined();
  });

  it('uses undefined currencyCode when no defaultCurrency provided and no match', () => {
    const result = buildSecurityMappings(new Set(['UNKNOWN']), []);

    expect(result[0].currencyCode).toBeUndefined();
  });

  it('handles multiple securities with mixed matches', () => {
    const securities = [makeSecurity({ id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.' })];
    const result = buildSecurityMappings(new Set(['AAPL', 'MSFT', 'GOOG']), securities, 'GBP');

    expect(result).toHaveLength(3);
    const matched = result.find((m) => m.originalName === 'AAPL');
    const unmatched1 = result.find((m) => m.originalName === 'MSFT');
    const unmatched2 = result.find((m) => m.originalName === 'GOOG');

    expect(matched!.securityId).toBe('sec-1');
    expect(matched!.currencyCode).toBeUndefined();
    expect(unmatched1!.securityId).toBeUndefined();
    expect(unmatched1!.currencyCode).toBe('GBP');
    expect(unmatched2!.securityId).toBeUndefined();
    expect(unmatched2!.currencyCode).toBe('GBP');
  });

  it('returns empty array for empty input set', () => {
    const result = buildSecurityMappings(new Set(), [], 'USD');
    expect(result).toHaveLength(0);
  });
});

describe('getCategoryPath', () => {
  it('returns plain name for top-level categories', () => {
    const cat = makeCategory({ id: 'c-1', name: 'Food', parentId: null });
    expect(getCategoryPath(cat, [cat])).toBe('Food');
  });

  it('returns parent: child for nested categories', () => {
    const parent = makeCategory({ id: 'p-1', name: 'Food' });
    const child = makeCategory({ id: 'c-1', name: 'Groceries', parentId: 'p-1' });
    expect(getCategoryPath(child, [parent, child])).toBe('Food: Groceries');
  });

  it('returns every level for a category nested more than once', () => {
    const housing = makeCategory({ id: 'h', name: 'Housing' });
    const mortgage = makeCategory({ id: 'm', name: 'Mortgage', parentId: 'h' });
    const interest = makeCategory({ id: 'i', name: 'Interest', parentId: 'm' });
    expect(getCategoryPath(interest, [housing, mortgage, interest])).toBe(
      'Housing: Mortgage: Interest',
    );
  });

  it('stops at a parent cycle instead of looping', () => {
    const a = makeCategory({ id: 'a', name: 'A', parentId: 'b' });
    const b = makeCategory({ id: 'b', name: 'B', parentId: 'a' });
    expect(getCategoryPath(a, [a, b])).toBe('B: A');
  });

  it('falls back to plain name when parent cannot be located', () => {
    const orphan = makeCategory({ id: 'c-1', name: 'Lost', parentId: 'missing' });
    expect(getCategoryPath(orphan, [orphan])).toBe('Lost');
  });
});

describe('findMatchingCategory', () => {
  it('matches by exact full path', () => {
    const parent = makeCategory({ id: 'p-1', name: 'Food' });
    const child = makeCategory({ id: 'c-1', name: 'Groceries', parentId: 'p-1' });
    expect(findMatchingCategory('Food:Groceries', [parent, child])).toBe('c-1');
  });

  it('matches case-insensitively', () => {
    const cat = makeCategory({ id: 'c-1', name: 'Entertainment' });
    expect(findMatchingCategory('entertainment', [cat])).toBe('c-1');
  });

  it('matches subcategory via parent disambiguation', () => {
    const parent = makeCategory({ id: 'p-1', name: 'Food' });
    const child = makeCategory({ id: 'c-1', name: 'Groceries', parentId: 'p-1' });
    expect(findMatchingCategory('food:groceries', [parent, child])).toBe('c-1');
  });

  it('matches subcategory by name when no parent specified', () => {
    const child = makeCategory({ id: 'c-1', name: 'Groceries', parentId: 'p-1' });
    expect(findMatchingCategory('Groceries', [child])).toBe('c-1');
  });

  it('returns undefined when nothing matches', () => {
    const cat = makeCategory({ id: 'c-1', name: 'Food' });
    expect(findMatchingCategory('Travel', [cat])).toBeUndefined();
  });

  it('matches with - replaced by / in QIF', () => {
    const cat = makeCategory({ id: 'c-1', name: 'Health/Medical' });
    // QIF replaces / with -, so 'Health-Medical' should match 'Health/Medical'
    expect(findMatchingCategory('Health-Medical', [cat])).toBe('c-1');
  });

  describe('multi-level paths', () => {
    const housing = makeCategory({ id: 'h', name: 'Housing' });
    const mortgage = makeCategory({ id: 'm', name: 'Mortgage', parentId: 'h' });
    const interest = makeCategory({ id: 'i', name: 'Interest', parentId: 'm' });
    const business = makeCategory({ id: 'b', name: 'Business' });
    const bizMortgage = makeCategory({ id: 'bm', name: 'Mortgage', parentId: 'b' });
    const bizInterest = makeCategory({ id: 'bi', name: 'Interest', parentId: 'bm' });

    it('matches a three-level path exactly, case-insensitively', () => {
      const all = [business, bizMortgage, bizInterest, housing, mortgage, interest];
      expect(findMatchingCategory('housing:mortgage:interest', all)).toBe('i');
      expect(findMatchingCategory('Business:Mortgage:Interest', all)).toBe('bi');
    });

    it('matches a deep QIF path to a shallower category with the same lower levels', () => {
      const topMortgage = makeCategory({ id: 'tm', name: 'Mortgage' });
      const topInterest = makeCategory({ id: 'ti', name: 'Interest', parentId: 'tm' });
      expect(findMatchingCategory('Housing:Mortgage:Interest', [topMortgage, topInterest])).toBe('ti');
    });

    it('does not match a category on a different branch with the same lower levels', () => {
      expect(
        findMatchingCategory('Housing:Mortgage:Interest', [business, bizMortgage, bizInterest]),
      ).toBeUndefined();
    });

    it('does not match a three-level path to a bare leaf name', () => {
      const leaf = makeCategory({ id: 'l', name: 'Interest' });
      expect(findMatchingCategory('Housing:Mortgage:Interest', [leaf])).toBeUndefined();
    });
  });
});

describe('findMatchingLoanAccount', () => {
  it('matches loan account by exact name', () => {
    const loan = makeAccount({ id: 'l-1', name: 'Car Loan', accountType: 'LOAN' });
    expect(findMatchingLoanAccount('Car Loan', [loan])).toBe('l-1');
  });

  it('matches mortgage account', () => {
    const m = makeAccount({ id: 'm-1', name: 'Home Mortgage', accountType: 'MORTGAGE' });
    expect(findMatchingLoanAccount('Home Mortgage', [m])).toBe('m-1');
  });

  it('matches partially when category contains the loan name', () => {
    const loan = makeAccount({ id: 'l-1', name: 'Car', accountType: 'LOAN' });
    expect(findMatchingLoanAccount('My Car Loan Payment', [loan])).toBe('l-1');
  });

  it('returns undefined when no loan accounts exist', () => {
    expect(findMatchingLoanAccount('Anything', [])).toBeUndefined();
  });

  it('returns undefined when there is no match', () => {
    const loan = makeAccount({ id: 'l-1', name: 'Car Loan', accountType: 'LOAN' });
    expect(findMatchingLoanAccount('Groceries', [loan])).toBeUndefined();
  });

  it('ignores non-loan/mortgage accounts', () => {
    const checking = makeAccount({ id: 'a-1', name: 'Car Loan', accountType: 'CHEQUING' });
    expect(findMatchingLoanAccount('Car Loan', [checking])).toBeUndefined();
  });
});

describe('matchFilenameToAccount', () => {
  it('matches investment-type files only against brokerage accounts', () => {
    const brokerage = makeAccount({
      id: 'b-1',
      name: 'My Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });
    const checking = makeAccount({ id: 'c-1', name: 'My Brokerage' });
    const result = matchFilenameToAccount('My Brokerage.qif', true, [brokerage, checking]);
    expect(result.id).toBe('b-1');
    expect(result.confidence).toBe('exact');
  });

  it('matches non-investment files against non-brokerage accounts', () => {
    const checking = makeAccount({ id: 'c-1', name: 'Daily' });
    const result = matchFilenameToAccount('Daily.qif', false, [checking]);
    expect(result.id).toBe('c-1');
    expect(result.confidence).toBe('exact');
  });

  it('returns partial confidence on substring match', () => {
    const checking = makeAccount({ id: 'c-1', name: 'Checking' });
    const result = matchFilenameToAccount('My Checking Account.qif', false, [checking]);
    expect(result.id).toBe('c-1');
    expect(result.confidence).toBe('partial');
  });

  it('returns type confidence when only account type matches', () => {
    const savings = makeAccount({ id: 's-1', name: 'Some Random Name', accountType: 'SAVINGS' });
    const result = matchFilenameToAccount('NoNameMatch.qif', false, [savings], 'SAVINGS');
    expect(result.id).toBe('s-1');
    expect(result.confidence).toBe('type');
  });

  it('returns none when nothing matches', () => {
    const result = matchFilenameToAccount('NoMatch.qif', false, []);
    expect(result.id).toBe('');
    expect(result.confidence).toBe('none');
  });
});

describe('buildCategoryMappings', () => {
  it('builds mapping with categoryId for matched categories', () => {
    const cat = makeCategory({ id: 'c-1', name: 'Food' });
    const result = buildCategoryMappings(new Set(['Food']), [cat], []);
    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe('c-1');
  });

  it('builds loan mapping when category matches a loan account', () => {
    const loan = makeAccount({ id: 'l-1', name: 'Car Loan', accountType: 'LOAN' });
    const result = buildCategoryMappings(new Set(['Car Loan']), [], [loan]);
    expect(result[0].isLoanCategory).toBe(true);
    expect(result[0].loanAccountId).toBe('l-1');
  });

  it('suggests createNew with parentCategoryId when parent already exists', () => {
    const parent = makeCategory({ id: 'p-1', name: 'Fees' });
    const result = buildCategoryMappings(new Set(['Fees:Bank Fee']), [parent], []);
    expect(result[0].createNew).toBe('Bank Fee');
    expect(result[0].parentCategoryId).toBe('p-1');
  });

  it('suggests createNew with createNewParentCategoryName when parent does not exist', () => {
    const result = buildCategoryMappings(new Set(['Fees:Bank Fee']), [], []);
    expect(result[0].createNew).toBe('Bank Fee');
    expect(result[0].createNewParentCategoryName).toBe('Fees');
  });

  it('suggests the leaf under an existing nested parent', () => {
    const housing = makeCategory({ id: 'h', name: 'Housing' });
    const mortgage = makeCategory({ id: 'm', name: 'Mortgage', parentId: 'h' });
    const result = buildCategoryMappings(
      new Set(['Housing:Mortgage:Interest']),
      [housing, mortgage],
      [],
    );
    expect(result[0]).toEqual({
      originalName: 'Housing:Mortgage:Interest',
      createNew: 'Interest',
      parentCategoryId: 'm',
    });
  });

  it('suggests a parent path for the levels that do not exist yet, spelling existing ones as stored', () => {
    // Used to suggest a single top-level parent named "Housing:Mortgage".
    const housing = makeCategory({ id: 'h', name: 'Housing' });
    const result = buildCategoryMappings(
      new Set(['housing:Mortgage:Interest', 'Auto:Fuel:Diesel']),
      [housing],
      [],
    );
    expect(result[0]).toEqual({
      originalName: 'housing:Mortgage:Interest',
      createNew: 'Interest',
      createNewParentCategoryName: 'Housing:Mortgage',
    });
    expect(result[1]).toEqual({
      originalName: 'Auto:Fuel:Diesel',
      createNew: 'Diesel',
      createNewParentCategoryName: 'Auto:Fuel',
    });
  });

  it('does not take a same-named category on another branch as the parent', () => {
    const business = makeCategory({ id: 'b', name: 'Business' });
    const bizMortgage = makeCategory({ id: 'bm', name: 'Mortgage', parentId: 'b' });
    const result = buildCategoryMappings(
      new Set(['Housing:Mortgage:Interest']),
      [business, bizMortgage],
      [],
    );
    expect(result[0].parentCategoryId).toBeUndefined();
    expect(result[0].createNewParentCategoryName).toBe('Housing:Mortgage');
  });

  it('falls back to undefined values when no matches and no colon', () => {
    const result = buildCategoryMappings(new Set(['Mystery']), [], []);
    expect(result[0]).toEqual({
      originalName: 'Mystery',
      categoryId: undefined,
      createNew: undefined,
    });
  });
});

describe('buildAccountMappings', () => {
  it('matches an existing account by name', () => {
    const acc = makeAccount({ id: 'a-1', name: 'Savings' });
    const result = buildAccountMappings(new Set(['Savings']), [acc], 'USD');
    expect(result[0].accountId).toBe('a-1');
  });

  it('targets the linked cash account for an investment brokerage match', () => {
    const brokerage = makeAccount({
      id: 'b-1',
      name: 'Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: 'cash-1',
    });
    const result = buildAccountMappings(new Set(['Brokerage']), [brokerage], 'USD');
    expect(result[0].accountId).toBe('cash-1');
  });

  it('matches investment cash account with " - cash" suffix', () => {
    const cash = makeAccount({
      id: 'cash-1',
      name: 'Brokerage - Cash',
      accountSubType: 'INVESTMENT_CASH',
    });
    const result = buildAccountMappings(new Set(['Brokerage']), [cash], 'USD');
    expect(result[0].accountId).toBe('cash-1');
  });

  it('proposes createNew with suggested type for unmatched accounts', () => {
    const result = buildAccountMappings(new Set(['New Savings']), [], 'CAD');
    expect(result[0].createNew).toBe('New Savings');
    expect(result[0].accountType).toBe('SAVINGS');
    expect(result[0].currencyCode).toBe('CAD');
  });
});

describe('findMatchingSecurityBySymbol', () => {
  function makeSec(overrides: Partial<Security> = {}): Security {
    return {
      id: 'sec-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      securityType: 'STOCK',
      exchange: 'NASDAQ',
      currencyCode: 'USD',
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
      quoteProvider: null,
      msnInstrumentId: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      ...overrides,
    } as Security;
  }

  it('matches case-insensitively', () => {
    const sec = makeSec({ symbol: 'AAPL' });
    expect(findMatchingSecurityBySymbol('aapl', [sec])).toBe(sec);
  });

  it('returns undefined for empty symbol', () => {
    expect(findMatchingSecurityBySymbol('', [makeSec()])).toBeUndefined();
  });

  it('returns undefined when symbol does not match', () => {
    expect(findMatchingSecurityBySymbol('TSLA', [makeSec({ symbol: 'AAPL' })])).toBeUndefined();
  });
});
