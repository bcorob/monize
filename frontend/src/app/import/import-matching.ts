/**
 * Pure functions for matching QIF data to existing entities during import.
 * These do not depend on React state and can be called from the import wizard hook.
 */
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Security } from '@/types/investment';
import { CategoryMapping, AccountMapping, SecurityMapping } from '@/lib/import';
import {
  MatchConfidence,
  suggestAccountType,
  formatCategoryPath,
  isInvestmentBrokerageAccount,
} from './import-utils';

/** The names from the root down to a category, at any depth */
function getCategoryChain(category: Category, categories: Category[]): string[] {
  const names = [category.name];
  const seen = new Set([category.id]);
  let parentId = category.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = categories.find((c) => c.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names;
}

/** Get the full path for a category at any depth (e.g., "Housing: Mortgage: Interest") */
export function getCategoryPath(category: Category, categories: Category[]): string {
  return getCategoryChain(category, categories).join(': ');
}

/** The levels of a colon-delimited QIF/CSV category path, root first. */
function splitCategoryPath(path: string): string[] {
  return path.split(':').map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * QIF files replace / with - in category names, so a segment also matches a
 * name with every - read as /.
 */
function segmentMatches(name: string, segment: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerSegment = segment.toLowerCase();
  return lowerName === lowerSegment || lowerName === lowerSegment.replace(/-/g, '/');
}

/**
 * Walk a category path from the root through the existing categories, and
 * return the chain matched before the first level that does not exist yet.
 */
function matchExistingPrefix(segments: string[], categories: Category[]): Category[] {
  const chain: Category[] = [];
  let parentId: string | null = null;
  for (const segment of segments) {
    const match = categories.find(
      (c) => (c.parentId ?? null) === parentId && segmentMatches(c.name, segment),
    );
    if (!match) break;
    chain.push(match);
    parentId = match.id;
  }
  return chain;
}

/** Find an existing category that matches a QIF category string */
export function findMatchingCategory(cat: string, categories: Category[]): string | undefined {
  const normalizedQifCat = formatCategoryPath(cat).toLowerCase();
  const qifParts = splitCategoryPath(cat);
  const qifLeaf = qifParts[qifParts.length - 1] ?? '';

  // QIF files replace / with - in category names, so also try matching with - replaced by /
  const normalizedQifCatWithSlash = normalizedQifCat.replace(/-/g, '/');

  // Try exact full path match
  let existingCat = categories.find((c) => {
    const catPath = getCategoryPath(c, categories).toLowerCase();
    return catPath === normalizedQifCat || catPath === normalizedQifCatWithSlash;
  });

  // Try matching category name against full normalized path
  if (!existingCat) {
    existingCat = categories.find((c) => {
      const catName = c.name.toLowerCase();
      return catName === normalizedQifCat || catName === normalizedQifCatWithSlash;
    });
  }

  // Try a path that agrees with the QIF one on every level both have, counted
  // up from the leaf, and on at least the leaf and its parent: "Mortgage:
  // Interest" for "Housing:Mortgage:Interest", or the reverse. A different
  // branch ("Business: Mortgage: Interest") disagrees on a shared level.
  if (!existingCat && qifParts.length > 1) {
    existingCat = categories.find((c) => {
      const chain = getCategoryChain(c, categories);
      const shared = Math.min(chain.length, qifParts.length);
      if (shared < 2) return false;
      for (let i = 1; i <= shared; i++) {
        if (!segmentMatches(chain[chain.length - i], qifParts[qifParts.length - i])) return false;
      }
      return true;
    });
  }

  // Match just the subcategory name (only if no parent specified in QIF)
  if (!existingCat && qifParts.length === 1) {
    existingCat = categories.find((c) => segmentMatches(c.name, qifLeaf));
  }

  return existingCat?.id;
}

/** Find a loan/mortgage account that matches a QIF category name */
export function findMatchingLoanAccount(cat: string, accounts: Account[]): string | undefined {
  const loanAccounts = accounts.filter(
    (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE'
  );

  if (loanAccounts.length === 0) return undefined;

  const normalizedCat = cat.toLowerCase().trim();
  const normalizedCatWithSlash = normalizedCat.replace(/-/g, '/');

  let matchedLoan = loanAccounts.find((a) => {
    const loanName = a.name.toLowerCase();
    return loanName === normalizedCat || loanName === normalizedCatWithSlash;
  });

  if (!matchedLoan) {
    matchedLoan = loanAccounts.find((a) => {
      const loanName = a.name.toLowerCase();
      return normalizedCat.includes(loanName) || loanName.includes(normalizedCat) ||
             normalizedCatWithSlash.includes(loanName) || loanName.includes(normalizedCatWithSlash);
    });
  }

  return matchedLoan?.id;
}

/** Match a filename to an existing account */
export function matchFilenameToAccount(
  fName: string,
  isInvestmentType: boolean,
  accounts: Account[],
  qifAccountType?: string,
): { id: string; confidence: MatchConfidence } {
  const baseName = fName.replace(/\.[^/.]+$/, '').trim().toLowerCase();
  const baseNameWithSlash = baseName.replace(/-/g, '/');

  const compatibleAccounts = accounts.filter((a) => {
    if (isInvestmentType) {
      return isInvestmentBrokerageAccount(a);
    } else {
      return !isInvestmentBrokerageAccount(a);
    }
  });

  const exactMatch = compatibleAccounts.find((a) => {
    const accountName = a.name.toLowerCase();
    return accountName === baseName || accountName === baseNameWithSlash;
  });
  if (exactMatch) return { id: exactMatch.id, confidence: 'exact' };

  const partialMatch = compatibleAccounts.find((a) => {
    const accountName = a.name.toLowerCase();
    return accountName.includes(baseName) || baseName.includes(accountName)
      || accountName.includes(baseNameWithSlash) || baseNameWithSlash.includes(accountName);
  });
  if (partialMatch) return { id: partialMatch.id, confidence: 'partial' };

  const typeMatch = qifAccountType
    ? compatibleAccounts.find((a) => a.accountType === qifAccountType)
    : undefined;
  if (typeMatch) return { id: typeMatch.id, confidence: 'type' };

  return { id: '', confidence: 'none' };
}

/** Build category mappings from QIF categories */
export function buildCategoryMappings(
  allCategories: Set<string>,
  categories: Category[],
  accounts: Account[],
): CategoryMapping[] {
  return Array.from(allCategories).map((cat) => {
    const categoryId = findMatchingCategory(cat, categories);
    if (categoryId) {
      return { originalName: cat, categoryId, createNew: undefined };
    }

    const loanAccountId = findMatchingLoanAccount(cat, accounts);
    if (loanAccountId) {
      return { originalName: cat, isLoanCategory: true, loanAccountId };
    }

    // For colon-separated categories (e.g., "Fees & Charges:Bank Fee" or
    // "Housing:Mortgage:Interest"), auto-suggest creating the leaf under the
    // parent path, reusing whichever levels of it already exist
    const parts = splitCategoryPath(cat);
    if (parts.length >= 2) {
      const parentParts = parts.slice(0, -1);
      const childName = parts[parts.length - 1];
      const existingChain = matchExistingPrefix(parentParts, categories);

      if (existingChain.length === parentParts.length) {
        return {
          originalName: cat,
          createNew: childName,
          parentCategoryId: existingChain[existingChain.length - 1].id,
        };
      }

      // The server finds or creates each level of this path in turn, so the
      // levels that already exist are spelled as they are stored.
      return {
        originalName: cat,
        createNew: childName,
        createNewParentCategoryName: [
          ...existingChain.map((c) => c.name),
          ...parentParts.slice(existingChain.length),
        ].join(':'),
      };
    }

    return { originalName: cat, categoryId: undefined, createNew: undefined };
  });
}

/** Build account mappings from QIF transfer accounts */
export function buildAccountMappings(
  allTransferAccounts: Set<string>,
  accounts: Account[],
  defaultCurrency: string,
): AccountMapping[] {
  return Array.from(allTransferAccounts).map((acc) => {
    const accLower = acc.toLowerCase();
    const accWithSlash = accLower.replace(/-/g, '/');
    const existingAcc = accounts.find((a) => {
      const aName = a.name.toLowerCase();
      return aName === accLower || aName === accWithSlash;
    });
    if (existingAcc) {
      const targetId = existingAcc.accountSubType === 'INVESTMENT_BROKERAGE' && existingAcc.linkedAccountId
        ? existingAcc.linkedAccountId
        : existingAcc.id;
      return { originalName: acc, accountId: targetId };
    }
    const investmentCashAcc = accounts.find((a) => {
      const aName = a.name.toLowerCase();
      return (aName === `${accLower} - cash` || aName === `${accWithSlash} - cash`)
        && a.accountSubType === 'INVESTMENT_CASH';
    });
    if (investmentCashAcc) {
      return { originalName: acc, accountId: investmentCashAcc.id };
    }
    return {
      originalName: acc,
      createNew: acc,
      accountType: suggestAccountType(acc),
      currencyCode: defaultCurrency,
    };
  });
}

/** Build security mappings from QIF securities.
 *  When a security is not matched to an existing one, the defaultCurrency
 *  is used as the initial currency (overridden later if exchange is known). */
export function buildSecurityMappings(
  allSecurities: Set<string>,
  securities: Security[],
  defaultCurrency?: string,
): SecurityMapping[] {
  return Array.from(allSecurities).map((sec) => {
    const existingSec = securities.find(
      (s) => s.symbol.toLowerCase() === sec.toLowerCase() || s.name.toLowerCase() === sec.toLowerCase()
    );
    return {
      originalName: sec,
      securityId: existingSec?.id,
      createNew: undefined,
      securityName: undefined,
      securityType: undefined,
      exchange: undefined,
      currencyCode: existingSec ? undefined : (defaultCurrency || undefined),
    };
  });
}

/** Check if a symbol matches an existing security */
export function findMatchingSecurityBySymbol(symbol: string, securities: Security[]): Security | undefined {
  if (!symbol) return undefined;
  const upperSymbol = symbol.toUpperCase().trim();
  return securities.find((s) => s.symbol.toUpperCase() === upperSymbol);
}
