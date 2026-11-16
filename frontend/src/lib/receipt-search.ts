import {
  EMAIL_RECEIPT_SEARCH_FIELDS,
  EMAIL_RECEIPT_SEARCH_MAX_LENGTH,
  type EmailReceiptSearch,
  type EmailReceiptSearchField,
} from '@/types/email-receipts';

/** What the search bar holds: the raw text and dates, before they are made into a request. */
export interface ReceiptSearchInput {
  text: string;
  searchIn: EmailReceiptSearchField;
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_RECEIPT_SEARCH_INPUT: ReceiptSearchInput = { text: '', searchIn: 'all', dateFrom: '', dateTo: '' };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as `YYYY-MM-DD`, else `''`. */
function validDay(raw: string): string {
  if (!YMD.test(raw)) return '';
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? '' : raw;
}

export function isReceiptSearchField(value: string | null | undefined): value is EmailReceiptSearchField {
  return EMAIL_RECEIPT_SEARCH_FIELDS.some((field) => field === value);
}

/** The end date is before the start date: the server refuses such a range, so the client does not send it. */
export function isReceiptRangeBackwards(input: Pick<ReceiptSearchInput, 'dateFrom' | 'dateTo'>): boolean {
  const from = validDay(input.dateFrom);
  const to = validDay(input.dateTo);
  return from !== '' && to !== '' && to < from;
}

/**
 * The request the bar's input makes. Text is trimmed and cut to the server's
 * bound; a blank text, an "all" field and an unreadable or backwards date
 * range are left out, so the server never sees a value it would refuse.
 */
export function normalizeReceiptSearch(input: ReceiptSearchInput): EmailReceiptSearch {
  const search = input.text.trim().slice(0, EMAIL_RECEIPT_SEARCH_MAX_LENGTH).trim();
  const backwards = isReceiptRangeBackwards(input);
  const dateFrom = backwards ? '' : validDay(input.dateFrom);
  const dateTo = backwards ? '' : validDay(input.dateTo);
  return {
    ...(search === '' ? {} : { search }),
    ...(search === '' || input.searchIn === 'all' ? {} : { searchIn: input.searchIn }),
    ...(dateFrom === '' ? {} : { dateFrom }),
    ...(dateTo === '' ? {} : { dateTo }),
  };
}

/** Whether the search narrows the list at all. */
export function isReceiptSearchActive(search: EmailReceiptSearch): boolean {
  return search.search !== undefined || search.dateFrom !== undefined || search.dateTo !== undefined;
}

/** One string for one search: part of every request key, so an answer is drawn only for the search that asked. */
export function receiptSearchKey(search: EmailReceiptSearch): string {
  return JSON.stringify([search.search ?? '', search.searchIn ?? 'all', search.dateFrom ?? '', search.dateTo ?? '']);
}

/** The query parameters of a search: only the fields that are set. */
export function receiptSearchParams(search: EmailReceiptSearch | undefined): EmailReceiptSearch {
  if (!search) return {};
  return {
    ...(search.search ? { search: search.search } : {}),
    ...(search.search && search.searchIn && search.searchIn !== 'all' ? { searchIn: search.searchIn } : {}),
    ...(search.dateFrom ? { dateFrom: search.dateFrom } : {}),
    ...(search.dateTo ? { dateTo: search.dateTo } : {}),
  };
}

const URL_KEYS = { text: 'q', searchIn: 'in', dateFrom: 'from', dateTo: 'to' } as const;

/** The bar's input as `?q=&in=&from=&to=` carries it; a value that is not valid is no filter. */
export function readReceiptSearchInput(params: { get(name: string): string | null }): ReceiptSearchInput {
  const field = params.get(URL_KEYS.searchIn);
  return {
    text: (params.get(URL_KEYS.text) ?? '').slice(0, EMAIL_RECEIPT_SEARCH_MAX_LENGTH),
    searchIn: isReceiptSearchField(field) ? field : 'all',
    dateFrom: validDay(params.get(URL_KEYS.dateFrom) ?? ''),
    dateTo: validDay(params.get(URL_KEYS.dateTo) ?? ''),
  };
}

/** Write the applied search into URL parameters (a copy), removing what is not set. */
export function writeReceiptSearchParams(params: URLSearchParams, search: EmailReceiptSearch): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  const set = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
  };
  set(URL_KEYS.text, search.search);
  set(URL_KEYS.searchIn, search.search && search.searchIn !== 'all' ? search.searchIn : undefined);
  set(URL_KEYS.dateFrom, search.dateFrom);
  set(URL_KEYS.dateTo, search.dateTo);
  return next;
}
