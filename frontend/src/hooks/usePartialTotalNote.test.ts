import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { usePartialTotalNote } from './usePartialTotalNote';

const complete = { value: 5, missingCurrencies: [], excludedCount: 0 };

describe('usePartialTotalNote', () => {
  it('writes nothing for a complete total', () => {
    const { result } = renderHook(() => usePartialTotalNote());
    expect(result.current.noteFor(complete)).toBeUndefined();
    expect(result.current.cellFor('$5.00', complete)).toBe('$5.00');
  });

  it('names the currencies with no rate', () => {
    const { result } = renderHook(() => usePartialTotalNote());
    const note = result.current.noteFor({ value: 5, missingCurrencies: ['EUR', 'JPY'], excludedCount: 2 });
    expect(note).toContain('EUR, JPY');
  });

  it('counts what was left out when no currency can be named', () => {
    const { result } = renderHook(() => usePartialTotalNote());
    expect(result.current.noteFor({ value: 5, missingCurrencies: [], excludedCount: 3 })).toContain('3');
  });

  it('suffixes a partial cell', () => {
    const { result } = renderHook(() => usePartialTotalNote());
    expect(
      result.current.cellFor('$5.00', { value: 5, missingCurrencies: [], excludedCount: 1 }),
    ).toBe('$5.00 (partial)');
  });
});
