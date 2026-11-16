import apiClient from './api';
import { API_MAX_PAGE_LIMIT } from './api-page-limits';
import { dedupe, invalidateCache } from './apiCache';
import { daysInMonth, isCalendarDate, monthOf, shiftDate, shiftMonth } from './calendar-month';
import type {
  CreateWarrantyClaimData,
  CreateWarrantyData,
  UpdateWarrantyClaimData,
  UpdateWarrantyData,
  Warranty,
  WarrantyClaim,
  WarrantyImportOptions,
  WarrantyImportResult,
  WarrantyListParams,
  WarrantyListResult,
  WarrantySummary,
  WarrantyTerm,
} from '@/types/warranty';

/**
 * Reads are short-lived on purpose: every warranty carries `status`,
 * `daysLeft` and `today` from the server, so an answer held past midnight
 * would print yesterday's days left.
 */
const READ_TTL_MS = 30_000;

/** The query string the list route reads, in a stable order for the cache key. */
function listQuery(params: WarrantyListParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.status) query.status = params.status;
  const q = params.q?.trim();
  if (q) query.q = q;
  if (params.transactionId) query.transactionId = params.transactionId;
  if (params.archived !== undefined) query.archived = String(params.archived);
  if (params.sort) query.sort = params.sort;
  if (params.sortDir) query.sortDir = params.sortDir;
  if (params.page !== undefined) query.page = String(params.page);
  if (params.limit !== undefined) query.limit = String(params.limit);
  return query;
}

/** Every write drops every cached read: a list, the summary and one warranty all move together. */
function afterWrite(): void {
  invalidateCache('warranties:');
}

export const warrantiesApi = {
  list: async (params: WarrantyListParams = {}): Promise<WarrantyListResult> => {
    const query = listQuery(params);
    return dedupe(
      `warranties:list:${new URLSearchParams(query).toString()}`,
      async () => {
        const response = await apiClient.get<WarrantyListResult>('/warranties', {
          params: query,
        });
        return response.data;
      },
      READ_TTL_MS,
    );
  },

  /**
   * Every warranty the filter matches, walking the pages at the server's
   * page ceiling (asking for more is a 400, not a bigger page). The CSV
   * export reads this: the page itself holds only the page on screen.
   */
  listAll: async (params: Omit<WarrantyListParams, 'page' | 'limit'> = {}): Promise<Warranty[]> => {
    const MAX_PAGES = 1000;
    const all: Warranty[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await warrantiesApi.list({ ...params, page, limit: API_MAX_PAGE_LIMIT });
      // An empty page ends the walk whatever `hasMore` says.
      if (result.data.length === 0) break;
      all.push(...result.data);
      if (!result.pagination.hasMore) break;
    }
    return all;
  },

  summary: async (): Promise<WarrantySummary> => {
    return dedupe(
      'warranties:summary',
      async () => {
        const response = await apiClient.get<WarrantySummary>('/warranties/summary');
        return response.data;
      },
      READ_TTL_MS,
    );
  },

  getById: async (id: string): Promise<Warranty> => {
    return dedupe(
      `warranties:one:${id}`,
      async () => {
        const response = await apiClient.get<Warranty>(`/warranties/${id}`);
        return response.data;
      },
      READ_TTL_MS,
    );
  },

  create: async (data: CreateWarrantyData): Promise<Warranty> => {
    const response = await apiClient.post<Warranty>('/warranties', data);
    afterWrite();
    return response.data;
  },

  update: async (id: string, data: UpdateWarrantyData): Promise<Warranty> => {
    const response = await apiClient.patch<Warranty>(`/warranties/${id}`, data);
    afterWrite();
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/warranties/${id}`);
    afterWrite();
  },

  archive: async (id: string): Promise<Warranty> => {
    const response = await apiClient.post<Warranty>(`/warranties/${id}/archive`);
    afterWrite();
    return response.data;
  },

  unarchive: async (id: string): Promise<Warranty> => {
    const response = await apiClient.post<Warranty>(`/warranties/${id}/unarchive`);
    afterWrite();
    return response.data;
  },

  /**
   * `POST /warranties/import`: a Warracker-format CSV. A preview
   * (`dryRun: true`) writes nothing; a commit creates the valid rows in one
   * server transaction, so only a commit that answered drops the cache.
   */
  import: async (file: File, options: WarrantyImportOptions): Promise<WarrantyImportResult> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<WarrantyImportResult>('/warranties/import', formData, {
      params: {
        dryRun: String(options.dryRun),
        skipInvalid: String(options.skipInvalid ?? false),
      },
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    if (!options.dryRun) afterWrite();
    return response.data;
  },

  listClaims: async (warrantyId: string): Promise<WarrantyClaim[]> => {
    return dedupe(
      `warranties:claims:${warrantyId}`,
      async () => {
        const response = await apiClient.get<WarrantyClaim[]>(`/warranties/${warrantyId}/claims`);
        return response.data;
      },
      READ_TTL_MS,
    );
  },

  // A claim write moves the warranty's `openClaimCount`, so it drops every
  // cached warranty read as well as the claim list.
  createClaim: async (warrantyId: string, data: CreateWarrantyClaimData): Promise<WarrantyClaim> => {
    const response = await apiClient.post<WarrantyClaim>(`/warranties/${warrantyId}/claims`, data);
    afterWrite();
    return response.data;
  },

  updateClaim: async (
    warrantyId: string,
    claimId: string,
    data: UpdateWarrantyClaimData,
  ): Promise<WarrantyClaim> => {
    const response = await apiClient.patch<WarrantyClaim>(`/warranties/${warrantyId}/claims/${claimId}`, data);
    afterWrite();
    return response.data;
  },

  deleteClaim: async (warrantyId: string, claimId: string): Promise<void> => {
    await apiClient.delete(`/warranties/${warrantyId}/claims/${claimId}`);
    afterWrite();
  },
};

function isWholeNonNegative(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The date a term starting on `purchaseDate` ends, for the form's duration
 * helper: years and months first, clamped to the end of the month when the
 * purchase day does not exist there (18 months from 2026-01-31 is 2027-07-31,
 * one month is 2026-02-28), then days. The same rule as the server's
 * `termToExpiresOn`; the form submits the date this returns, never the term.
 *
 * `null` when there is nothing to compute: an unreadable purchase date, a
 * negative or fractional part, or a term that is zero in total.
 *
 * Integer arithmetic on the calendar date (`lib/calendar-month.ts`), never a
 * `Date`: a `Date` built from a calendar date is an instant in the browser's
 * zone and can land a day early.
 */
export function warrantyTermEndDate(purchaseDate: string, term: WarrantyTerm): string | null {
  if (!isCalendarDate(purchaseDate)) return null;
  const years = term.years ?? 0;
  const months = term.months ?? 0;
  const days = term.days ?? 0;
  if (![years, months, days].every(isWholeNonNegative)) return null;
  if (years + months + days === 0) return null;

  const day = Number(purchaseDate.slice(8, 10));
  const month = shiftMonth(monthOf(purchaseDate), years * 12 + months);
  const [y, m] = month.split('-').map(Number);
  const clamped = Math.min(day, daysInMonth(y, m));
  return shiftDate(`${month}-${String(clamped).padStart(2, '0')}`, days);
}

/**
 * The DTO's "expiresOn must be on or after purchaseDate", for the form to
 * report at the field. Both are `YYYY-MM-DD`, whose string order is calendar
 * order. A validation rule, not a status: whether a warranty is expiring or
 * expired is only ever the server's `status` (WTY-002).
 */
export function expiresBeforePurchase(expiresOn: string, purchaseDate: string): boolean {
  return isCalendarDate(expiresOn) && isCalendarDate(purchaseDate) && expiresOn < purchaseDate;
}
