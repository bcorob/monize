import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearIdentityScopedSessionStorage,
  IDENTITY_SCOPED_SESSION_KEYS,
  INTRADAY_CACHE_PREFIX,
} from './identity-session-storage';
import { LAST_TRANSACTION_CURRENCY_KEY } from './lastTransactionCurrency';
import {
  LAST_TRANSACTION_DATE_KEY,
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
} from './lastTransactionDate';

describe('clearIdentityScopedSessionStorage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('names every key that remembers a value from one account', () => {
    expect([...IDENTITY_SCOPED_SESSION_KEYS].sort()).toEqual(
      [
        LAST_TRANSACTION_CURRENCY_KEY,
        LAST_TRANSACTION_DATE_KEY,
        LAST_INVESTMENT_TRANSACTION_DATE_KEY,
      ].sort(),
    );
  });

  it('removes the intraday entries and the remembered values', () => {
    window.sessionStorage.setItem(`${INTRADAY_CACHE_PREFIX}u:a|a:self|1d||USD`, '1');
    window.sessionStorage.setItem(`${INTRADAY_CACHE_PREFIX}u:b|a:o1|1w||EUR`, '2');
    for (const k of IDENTITY_SCOPED_SESSION_KEYS) {
      window.sessionStorage.setItem(k, '3');
    }

    clearIdentityScopedSessionStorage();

    expect(window.sessionStorage.length).toBe(0);
  });

  it('leaves identity-neutral entries alone', () => {
    window.sessionStorage.setItem('postLoginReturnTo', '/accounts');
    window.sessionStorage.setItem('swipe-enter', 'from-left');

    clearIdentityScopedSessionStorage();

    expect(window.sessionStorage.getItem('postLoginReturnTo')).toBe('/accounts');
    expect(window.sessionStorage.getItem('swipe-enter')).toBe('from-left');
  });
});
