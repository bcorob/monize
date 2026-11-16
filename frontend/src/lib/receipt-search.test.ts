import { describe, it, expect } from 'vitest';
import {
  EMPTY_RECEIPT_SEARCH_INPUT,
  isReceiptRangeBackwards,
  isReceiptSearchActive,
  normalizeReceiptSearch,
  readReceiptSearchInput,
  receiptSearchKey,
  receiptSearchParams,
  writeReceiptSearchParams,
} from './receipt-search';

const input = (patch: Partial<typeof EMPTY_RECEIPT_SEARCH_INPUT>) => ({ ...EMPTY_RECEIPT_SEARCH_INPUT, ...patch });

describe('receipt search', () => {
  it('trims the text, cuts it to 200 characters and leaves a blank one out', () => {
    expect(normalizeReceiptSearch(input({ text: '  invoice  ' }))).toEqual({ search: 'invoice' });
    expect(normalizeReceiptSearch(input({ text: '   ' }))).toEqual({});
    expect(normalizeReceiptSearch(input({ text: 'a'.repeat(250) })).search).toHaveLength(200);
  });

  it('sends the field only for a text and not for "all"', () => {
    expect(normalizeReceiptSearch(input({ text: 'x', searchIn: 'body' }))).toEqual({ search: 'x', searchIn: 'body' });
    expect(normalizeReceiptSearch(input({ text: 'x', searchIn: 'all' }))).toEqual({ search: 'x' });
    expect(normalizeReceiptSearch(input({ searchIn: 'body' }))).toEqual({});
  });

  it('keeps a valid date range and drops an unreadable date or a backwards range', () => {
    expect(normalizeReceiptSearch(input({ dateFrom: '2026-09-01', dateTo: '2026-09-01' }))).toEqual({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-01',
    });
    expect(normalizeReceiptSearch(input({ dateFrom: '2026-02-30' }))).toEqual({});
    expect(normalizeReceiptSearch(input({ dateTo: 'yesterday' }))).toEqual({});
    const backwards = input({ dateFrom: '2026-09-10', dateTo: '2026-09-01' });
    expect(isReceiptRangeBackwards(backwards)).toBe(true);
    expect(normalizeReceiptSearch(backwards)).toEqual({});
  });

  it('knows when a search narrows and gives each search its own key', () => {
    expect(isReceiptSearchActive({})).toBe(false);
    expect(isReceiptSearchActive({ dateTo: '2026-09-01' })).toBe(true);
    expect(receiptSearchKey({})).toBe(receiptSearchKey({ searchIn: 'all' }));
    expect(receiptSearchKey({ search: 'a' })).not.toBe(receiptSearchKey({ search: 'b' }));
    expect(receiptSearchKey({ search: 'a' })).not.toBe(receiptSearchKey({ search: 'a', searchIn: 'body' }));
  });

  it('builds query parameters from the set fields only', () => {
    expect(receiptSearchParams(undefined)).toEqual({});
    expect(receiptSearchParams({ search: '', searchIn: 'body' })).toEqual({});
    expect(receiptSearchParams({ search: 'a', searchIn: 'all', dateFrom: '2026-09-01' })).toEqual({
      search: 'a',
      dateFrom: '2026-09-01',
    });
  });

  it('reads the URL, ignoring a field that is not valid', () => {
    expect(readReceiptSearchInput(new URLSearchParams('q=hello&in=sender&from=2026-09-01&to=2026-09-30'))).toEqual({
      text: 'hello',
      searchIn: 'sender',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    });
    expect(readReceiptSearchInput(new URLSearchParams('in=everything&from=soon'))).toEqual(EMPTY_RECEIPT_SEARCH_INPUT);
  });

  it('writes the applied search to a copy of the URL, keeping the other parameters and removing what is unset', () => {
    const before = new URLSearchParams('tab=emails&domain=shop.pl&q=old&in=body&from=2026-01-01');
    const next = writeReceiptSearchParams(before, { search: 'new', dateTo: '2026-09-30' });
    expect(next.toString()).toBe('tab=emails&domain=shop.pl&q=new&to=2026-09-30');
    expect(before.get('q')).toBe('old');
    expect(writeReceiptSearchParams(next, {}).toString()).toBe('tab=emails&domain=shop.pl');
  });
});
