import type { RuleRunFilters } from '@/types/transaction-rule-run';

/** Newest rows a test or run examines when the reader does not say (`DEFAULT_RULE_RUN_LIMIT` on the server). */
export const DEFAULT_RULE_RUN_LIMIT = 200;
/** The most the server accepts (`MAX_RULE_RUN_LIMIT`). */
export const MAX_RULE_RUN_LIMIT = 1000;

/** The filters as the form holds them; empty strings and lists mean "no restriction". */
export interface RunFiltersState {
  accountIds: string[];
  startDate: string;
  endDate: string;
  limit: number | undefined;
}

export const DEFAULT_RUN_FILTERS: RunFiltersState = {
  accountIds: [],
  startDate: '',
  endDate: '',
  limit: DEFAULT_RULE_RUN_LIMIT,
};

/** What the endpoints take: only the restrictions the reader actually set. */
export function filtersToRequest(filters: RunFiltersState): RuleRunFilters {
  return {
    ...(filters.accountIds.length > 0 ? { accountIds: filters.accountIds } : {}),
    ...(filters.startDate ? { startDate: filters.startDate } : {}),
    ...(filters.endDate ? { endDate: filters.endDate } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
  };
}

/** True when the range is backwards; the server refuses it, so the form says so first. */
export function hasBackwardsRange(filters: RunFiltersState): boolean {
  return filters.startDate !== '' && filters.endDate !== '' && filters.startDate > filters.endDate;
}

/** Two states with the same key ask the server the same question. */
export function filtersKey(filters: RunFiltersState): string {
  return JSON.stringify(filtersToRequest(filters));
}
