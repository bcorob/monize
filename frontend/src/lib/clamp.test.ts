import { describe, it, expect } from 'vitest';
import { clamp } from './clamp';

describe('clamp', () => {
  it('returns a value already inside the range unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('pulls a value outside the range to the nearer bound', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('lets the lower bound win when the range is empty', () => {
    expect(clamp(5, 8, 2)).toBe(8);
  });
});
