import { Account, isLiabilityAccountType } from '@/types/account';
import type { LogicalAccount } from '@/lib/logical-accounts';

/**
 * How the Account Balances report picks, groups and orders its rows
 * (issue #1198). Kept out of the component so each rule is testable on its own
 * and so the report stays a rendering of these decisions rather than the place
 * they are made.
 */

export type BalanceScope = 'all' | 'assets' | 'liabilities';
export type StatusFilter = 'open' | 'closed' | 'all';
export type FavouriteFilter = 'all' | 'favourites' | 'others';
export type GroupBy =
  | 'assetLiability'
  | 'type'
  | 'institution'
  | 'status'
  | 'favourite'
  | 'none';
export type SortBy = 'name' | 'balance';
export type SortDirection = 'asc' | 'desc';

export const GROUP_BY_OPTIONS: readonly GroupBy[] = [
  'assetLiability',
  'type',
  'institution',
  'status',
  'favourite',
  'none',
] as const;

export const SORT_BY_OPTIONS: readonly SortBy[] = ['name', 'balance'] as const;

/** The bucket for an account filed under no institution at all. */
export const INSTITUTION_NONE = '__none__';

export interface AccountBalanceFilters {
  scope: BalanceScope;
  /** Institution keys; empty means every institution. */
  institutionKeys: string[];
  /** Account types; empty means every type. */
  accountTypes: string[];
  status: StatusFilter;
  favourite: FavouriteFilter;
}

export const DEFAULT_FILTERS: AccountBalanceFilters = {
  scope: 'all',
  institutionKeys: [],
  accountTypes: [],
  status: 'open',
  favourite: 'all',
};

/**
 * The institution an account belongs to, as a stable key.
 *
 * `institutionId` is the structured record; `institution` is the legacy
 * free-text name that predates it and is still the only thing some accounts
 * carry. Folding both into one key means an account imported before
 * institutions existed groups with the others under the same name instead of
 * disappearing into "no institution".
 */
export function institutionKeyFor(account: Account): string {
  if (account.institutionId) return account.institutionId;
  if (account.institution) return `name:${account.institution}`;
  return INSTITUTION_NONE;
}

/** True when the account passes every active filter. */
export function matchesFilters(
  account: Account,
  filters: AccountBalanceFilters,
): boolean {
  const isLiability = isLiabilityAccountType(account.accountType);
  if (filters.scope === 'assets' && isLiability) return false;
  if (filters.scope === 'liabilities' && !isLiability) return false;

  if (filters.status === 'open' && account.isClosed) return false;
  if (filters.status === 'closed' && !account.isClosed) return false;

  if (filters.favourite === 'favourites' && !account.isFavourite) return false;
  if (filters.favourite === 'others' && account.isFavourite) return false;

  // An empty selection means "no restriction", not "nothing" -- a multi-select
  // the user has not touched must not empty the report.
  if (
    filters.accountTypes.length > 0 &&
    !filters.accountTypes.includes(account.accountType)
  ) {
    return false;
  }
  if (
    filters.institutionKeys.length > 0 &&
    !filters.institutionKeys.includes(institutionKeyFor(account))
  ) {
    return false;
  }

  return true;
}

/**
 * The group an entity belongs to under the chosen grouping.
 *
 * A linked investment pair is one entity, so the key comes from its primary
 * (brokerage) row -- the cash half carries the same institution, status and
 * favourite flag by construction, and its type would file the pair under
 * "Investment" twice.
 */
export function groupKeyFor(entry: LogicalAccount, groupBy: GroupBy): string {
  const account = entry.primary;
  switch (groupBy) {
    case 'assetLiability':
      return isLiabilityAccountType(account.accountType)
        ? 'liabilities'
        : 'assets';
    case 'type':
      return account.accountType || 'OTHER';
    case 'institution':
      return institutionKeyFor(account);
    case 'status':
      return account.isClosed ? 'closed' : 'open';
    case 'favourite':
      return account.isFavourite ? 'favourite' : 'other';
    case 'none':
      return 'all';
  }
}

/**
 * Groups whose members have a natural order rather than the order the accounts
 * happened to arrive in. Anything not listed keeps first-appearance order, so a
 * user's own account ordering survives.
 */
const FIXED_GROUP_ORDER: Partial<Record<GroupBy, readonly string[]>> = {
  assetLiability: ['assets', 'liabilities'],
  status: ['open', 'closed'],
  favourite: ['favourite', 'other'],
};

/** Split entities into groups, in the order the groups should be rendered. */
export function groupEntries(
  entries: LogicalAccount[],
  groupBy: GroupBy,
): Array<{ key: string; entries: LogicalAccount[] }> {
  const groups = new Map<string, LogicalAccount[]>();
  for (const entry of entries) {
    const key = groupKeyFor(entry, groupBy);
    const existing = groups.get(key);
    groups.set(key, existing ? [...existing, entry] : [entry]);
  }

  const fixed = FIXED_GROUP_ORDER[groupBy];
  const keys = fixed
    ? [...groups.keys()].sort((a, b) => fixed.indexOf(a) - fixed.indexOf(b))
    : [...groups.keys()];

  return keys.map((key) => ({ key, entries: groups.get(key)! }));
}

/**
 * Order the entities inside one group.
 *
 * `toDisplayValue` returns the figure the row actually shows, expressed in one
 * common currency -- the same absolute value a liability row prints, the signed
 * value everything else prints -- so the order on screen matches the numbers on
 * screen. A value it cannot produce, because the server could not work it out
 * or no exchange rate reaches the display currency, has no place on the scale
 * at all: those rows go **last in both directions** rather than being scored as
 * zero, since an unknown balance sorted among the small ones reads as a small
 * balance.
 */
export function sortEntries(
  entries: LogicalAccount[],
  sortBy: SortBy,
  direction: SortDirection,
  toDisplayValue: (entry: LogicalAccount) => number | null,
): LogicalAccount[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (sortBy === 'name') {
      return sign * a.displayName.localeCompare(b.displayName);
    }
    const aValue = toDisplayValue(a);
    const bValue = toDisplayValue(b);
    if (aValue === null && bValue === null) {
      return a.displayName.localeCompare(b.displayName);
    }
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    if (aValue === bValue) return a.displayName.localeCompare(b.displayName);
    return sign * (aValue - bValue);
  });
}
