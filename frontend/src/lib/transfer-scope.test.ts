import { describe, it, expect } from 'vitest';
import { MAX_TRANSFER_SCOPE_IDS, transferScopeFor, transferScopeKey } from './transfer-scope';

describe('transferScopeFor (spec 10.8.1)', () => {
  it('sends no boundary when the selection already scopes the report', () => {
    expect(transferScopeFor(['a1'], ['a1', 'a2'])).toEqual({ pending: false });
  });

  it('is pending while the offered accounts load', () => {
    expect(transferScopeFor([], null)).toEqual({ pending: true });
  });

  it('bounds "All Accounts" by every offered account', () => {
    expect(transferScopeFor([], ['a1', 'a2'])).toEqual({
      pending: false,
      accountIds: ['a1', 'a2'],
    });
  });

  it('sends no boundary for an empty offer (or a failed load passed as one)', () => {
    expect(transferScopeFor([], [])).toEqual({ pending: false });
  });

  it('sends no boundary over the server cap rather than a refused request', () => {
    const ids = Array.from({ length: MAX_TRANSFER_SCOPE_IDS + 1 }, (_, i) => `a${i}`);
    expect(transferScopeFor([], ids)).toEqual({ pending: false });
    expect(transferScopeFor([], ids.slice(0, MAX_TRANSFER_SCOPE_IDS)).accountIds).toHaveLength(
      MAX_TRANSFER_SCOPE_IDS,
    );
  });

  it('keys each state apart', () => {
    expect(transferScopeKey({ pending: true })).toBe('pending');
    expect(transferScopeKey({ pending: false })).toBe('');
    expect(transferScopeKey({ pending: false, accountIds: ['a1', 'a2'] })).toBe('a1,a2');
  });
});
