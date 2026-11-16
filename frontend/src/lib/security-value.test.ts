import { describe, it, expect } from 'vitest';
import { securityPositionValue, compareSecurityValues } from './security-value';

describe('securityPositionValue', () => {
  it('multiplies shares by the latest close', () => {
    expect(securityPositionValue(10, 150.25)).toBe(1502.5);
  });

  it('rounds to money precision rather than carrying float drift', () => {
    // 0.1 * 3 is 0.30000000000000004 in IEEE 754.
    expect(securityPositionValue(3, 0.1)).toBe(0.3);
    expect(securityPositionValue(3, 1.23456)).toBe(3.7037);
  });

  it('reads shares and price that arrive as decimal strings', () => {
    expect(securityPositionValue('2.5', '4')).toBe(10);
  });

  it('is zero for a security nobody holds, whatever the price', () => {
    expect(securityPositionValue(0, 150)).toBe(0);
    // No price either: zero shares needs none, so this is still a measured zero
    // and not a gap.
    expect(securityPositionValue(0, null)).toBe(0);
    expect(securityPositionValue(undefined, null)).toBe(0);
  });

  it('is unknown -- never zero -- when a held position has no usable price', () => {
    expect(securityPositionValue(10, null)).toBeNull();
    expect(securityPositionValue(10, undefined)).toBeNull();
    // A stored close of 0, a negative, or an unparseable value is no price at
    // all; folding any of them in would report the position as worthless.
    expect(securityPositionValue(10, 0)).toBeNull();
    expect(securityPositionValue(10, -5)).toBeNull();
    expect(securityPositionValue(10, 'n/a')).toBeNull();
    expect(securityPositionValue(10, Number.NaN)).toBeNull();
  });

  it('values a short position at its negative worth', () => {
    expect(securityPositionValue(-4, 25)).toBe(-100);
  });
});

describe('compareSecurityValues', () => {
  it('orders known values by the requested direction', () => {
    expect(compareSecurityValues(1, 2, 'asc')).toBeLessThan(0);
    expect(compareSecurityValues(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareSecurityValues(2, 2, 'asc')).toBe(0);
  });

  it('sinks unknown values in both directions', () => {
    expect(compareSecurityValues(null, 2, 'asc')).toBeGreaterThan(0);
    expect(compareSecurityValues(null, 2, 'desc')).toBeGreaterThan(0);
    expect(compareSecurityValues(2, null, 'asc')).toBeLessThan(0);
    expect(compareSecurityValues(2, null, 'desc')).toBeLessThan(0);
    expect(compareSecurityValues(null, null, 'asc')).toBe(0);
  });

  it('keeps unknown last through an actual sort, ascending and descending', () => {
    const rows: Array<[string, number | null]> = [
      ['unknown', null],
      ['big', 900],
      ['small', 5],
    ];
    const order = (direction: 'asc' | 'desc') =>
      [...rows]
        .sort((a, b) => compareSecurityValues(a[1], b[1], direction))
        .map(([label]) => label);

    expect(order('asc')).toEqual(['small', 'big', 'unknown']);
    expect(order('desc')).toEqual(['big', 'small', 'unknown']);
  });
});
