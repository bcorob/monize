import { describe, it, expect } from 'vitest';
import {
  NO_EXCLUSIONS,
  addExclusion,
  deselects,
  hasExclusions,
  isBulkApprovable,
  isTradeProposal,
  receivedDay,
  selectionFilter,
} from './receipt-selection';

describe('receipt selection', () => {
  it('adds no field to a filter without exclusions', () => {
    expect(selectionFilter({ domain: 'gmail.com' }, NO_EXCLUSIONS)).toEqual({ domain: 'gmail.com' });
    expect(hasExclusions(NO_EXCLUSIONS)).toBe(false);
  });

  it('writes every exclusion into the filter', () => {
    let ex = addExclusion(NO_EXCLUSIONS, { kind: 'status', status: 'ignored' });
    ex = addExclusion(ex, { kind: 'domain', domain: 'shop.pl' });
    ex = addExclusion(ex, { kind: 'before', day: '2026-09-01' });
    ex = addExclusion(ex, { kind: 'after', day: '2026-10-01' });
    expect(hasExclusions(ex)).toBe(true);
    expect(selectionFilter({ status: 'review' }, ex)).toEqual({
      status: 'review',
      excludeStatuses: ['ignored'],
      excludeDomains: ['shop.pl'],
      receivedFrom: '2026-09-01',
      receivedTo: '2026-10-01',
    });
  });

  it('writes the search into the filter beside the state and domain, and the exclusions on top of it', () => {
    const search = { search: 'invoice', searchIn: 'sender' as const, dateFrom: '2026-09-01', dateTo: '2026-09-30' };
    expect(selectionFilter({ status: 'review', domain: 'shop.pl', ...search }, NO_EXCLUSIONS)).toEqual({
      status: 'review',
      domain: 'shop.pl',
      ...search,
    });
    const ex = addExclusion(NO_EXCLUSIONS, { kind: 'status', status: 'ignored' });
    expect(selectionFilter(search, ex)).toEqual({ ...search, excludeStatuses: ['ignored'] });
    // The search's dates are not the received-day exclusions.
    expect(selectionFilter(search, ex)).not.toHaveProperty('receivedFrom');
  });

  it('keeps the same object for a repeated exclusion and only narrows a range', () => {
    const one = addExclusion(NO_EXCLUSIONS, { kind: 'status', status: 'ignored' });
    expect(addExclusion(one, { kind: 'status', status: 'ignored' })).toBe(one);
    const from = addExclusion(NO_EXCLUSIONS, { kind: 'before', day: '2026-09-10' });
    expect(addExclusion(from, { kind: 'before', day: '2026-09-01' }).from).toBe('2026-09-10');
    expect(addExclusion(from, { kind: 'before', day: '2026-09-20' }).from).toBe('2026-09-20');
    const to = addExclusion(NO_EXCLUSIONS, { kind: 'after', day: '2026-09-10' });
    expect(addExclusion(to, { kind: 'after', day: '2026-09-20' }).to).toBe('2026-09-10');
    expect(addExclusion(to, { kind: 'after', day: '2026-09-01' }).to).toBe('2026-09-01');
  });

  it('judges a row by its state, sender (and sub-domains) and UTC day', () => {
    const row = { status: 'ignored' as const, fromDomain: 'mail.shop.pl', receivedAt: '2026-09-03T23:59:00.000Z' };
    expect(receivedDay(row.receivedAt)).toBe('2026-09-03');
    expect(deselects(row, { kind: 'status', status: 'ignored' })).toBe(true);
    expect(deselects(row, { kind: 'status', status: 'review' })).toBe(false);
    expect(deselects(row, { kind: 'domain', domain: 'shop.pl' })).toBe(true);
    expect(deselects(row, { kind: 'domain', domain: 'op.pl' })).toBe(false);
    expect(deselects(row, { kind: 'before', day: '2026-09-03' })).toBe(false);
    expect(deselects(row, { kind: 'before', day: '2026-09-04' })).toBe(true);
    expect(deselects(row, { kind: 'after', day: '2026-09-03' })).toBe(false);
    expect(deselects(row, { kind: 'after', day: '2026-09-02' })).toBe(true);
  });

  it('approves only a proposed, non-trade email with a request', () => {
    const base = { status: 'review' as const, displayState: 'proposed' as const, isTrade: false, aiReviewRequestId: 'rq' };
    expect(isBulkApprovable(base)).toBe(true);
    expect(isBulkApprovable({ ...base, isTrade: true })).toBe(false);
    expect(isBulkApprovable({ ...base, aiReviewRequestId: null })).toBe(false);
    expect(isBulkApprovable({ ...base, displayState: null })).toBe(false);
    expect(isBulkApprovable({ ...base, status: 'unmatched' })).toBe(false);
    expect(isTradeProposal({ ...base, isTrade: true })).toBe(true);
    expect(isTradeProposal(base)).toBe(false);
  });
});
