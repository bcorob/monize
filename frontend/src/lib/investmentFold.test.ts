import { describe, it, expect } from 'vitest';
import { totalFromQuantity, quantityFromTotal, roundPrice, roundMoney, usableClose } from './investmentFold';

describe('usableClose', () => {
  it('returns the latest positive close with its date', () => {
    expect(usableClose([{ closePrice: 123.45, priceDate: '2026-05-09' }])).toEqual({
      price: 123.45,
      date: '2026-05-09',
    });
  });

  it('coerces a numeric string close', () => {
    expect(usableClose([{ closePrice: '99.5', priceDate: '2026-05-09' }])).toEqual({
      price: 99.5,
      date: '2026-05-09',
    });
  });

  it('is null for an empty response', () => {
    expect(usableClose([])).toBeNull();
  });

  it('is null for a zero, negative or non-numeric close', () => {
    expect(usableClose([{ closePrice: 0 }])).toBeNull();
    expect(usableClose([{ closePrice: -5 }])).toBeNull();
    expect(usableClose([{ closePrice: 'abc' }])).toBeNull();
    expect(usableClose([{ closePrice: NaN }])).toBeNull();
  });

  it('defaults a missing date to null', () => {
    expect(usableClose([{ closePrice: 10 }])).toEqual({ price: 10, date: null });
  });
});

describe('roundMoney', () => {
  it('rounds to money precision (4dp)', () => {
    expect(roundMoney(1.23456)).toBe(1.2346);
    expect(roundMoney(1.23454)).toBe(1.2345);
    expect(roundMoney(99.99999)).toBe(100);
    expect(roundMoney(100)).toBe(100);
  });
});

describe('roundPrice', () => {
  it('rounds to price precision (6dp)', () => {
    expect(roundPrice(1.2345674)).toBe(1.234567);
    expect(roundPrice(1.2345676)).toBe(1.234568);
    expect(roundPrice(123)).toBe(123);
  });
});

describe('totalFromQuantity', () => {
  it('folds a buy commission into the total (sign +1)', () => {
    expect(totalFromQuantity(10, 100, 1, 5)).toBe(1005);
  });

  it('nets a sell commission out of the total (sign -1)', () => {
    expect(totalFromQuantity(10, 100, -1, 5)).toBe(995);
  });

  it('rounds to money precision (4dp)', () => {
    // 3 * 33.3333 = 99.9999, commission 0
    expect(totalFromQuantity(3, 33.3333, 1, 0)).toBe(99.9999);
    // A fifth decimal rounds into the fourth.
    expect(totalFromQuantity(3, 33.33335, 1, 0)).toBe(100.0001);
  });
});

describe('quantityFromTotal', () => {
  it('backs a buy commission out before dividing (sign +1)', () => {
    // (1005 - 5) / 100 = 10
    expect(quantityFromTotal(1005, 100, 1, 5)).toBe(10);
  });

  it('adds a sell commission back before dividing (sign -1)', () => {
    // (995 - (-1*5)) / 100 = 10
    expect(quantityFromTotal(995, 100, -1, 5)).toBe(10);
  });

  it('rounds to share precision (8dp)', () => {
    // 1000 / 123.45 = 8.100445524..., rounded to 8dp = 8.10044552
    expect(quantityFromTotal(1000, 123.45, 1, 0)).toBe(8.10044552);
  });

  it('never returns a negative quantity when commission exceeds the total', () => {
    expect(quantityFromTotal(3, 100, 1, 10)).toBe(0);
  });

  it('returns 0 rather than dividing by a non-positive price', () => {
    expect(quantityFromTotal(1000, 0, 1, 0)).toBe(0);
    expect(quantityFromTotal(1000, -5, 1, 0)).toBe(0);
  });
});
