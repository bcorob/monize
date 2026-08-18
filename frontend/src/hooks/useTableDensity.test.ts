import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTableDensity, nextDensity } from './useTableDensity';

describe('useTableDensity', () => {
  it('returns dense padding for dense density', () => {
    const { result } = renderHook(() => useTableDensity('dense'));
    expect(result.current.cellPadding).toBe('px-3 py-1');
    expect(result.current.headerPadding).toBe('px-3 py-2');
  });

  it('returns compact padding for compact density', () => {
    const { result } = renderHook(() => useTableDensity('compact'));
    expect(result.current.cellPadding).toBe('px-4 py-2');
    expect(result.current.headerPadding).toBe('px-4 py-2');
  });

  it('returns normal (default) padding for normal density', () => {
    const { result } = renderHook(() => useTableDensity('normal'));
    expect(result.current.cellPadding).toBe('px-3 sm:px-6 py-4');
    expect(result.current.headerPadding).toBe('px-3 sm:px-6 py-3');
  });
});

describe('useTableDensity wide scale', () => {
  // The investment register's values. They lived in that component until three
  // -- in fact five -- copies of this table had drifted apart; pinned here so a
  // change to them is a change to a named table rather than to one file's
  // `switch` that nobody compares against the others.
  it('halves the phone inset at every level', () => {
    const dense = renderHook(() => useTableDensity('dense', 'wide'));
    expect(dense.result.current.cellPadding).toBe('px-1.5 sm:px-3 py-1');
    expect(dense.result.current.headerPadding).toBe('px-1.5 sm:px-3 py-2');

    const compact = renderHook(() => useTableDensity('compact', 'wide'));
    expect(compact.result.current.cellPadding).toBe('px-2 sm:px-4 py-2');
    expect(compact.result.current.headerPadding).toBe('px-2 sm:px-4 py-2');

    const normal = renderHook(() => useTableDensity('normal', 'wide'));
    expect(normal.result.current.cellPadding).toBe('px-2 sm:px-6 py-3 sm:py-4');
    expect(normal.result.current.headerPadding).toBe('px-2 sm:px-6 py-2 sm:py-3');
  });

  it('differs from the default scale at every level, so naming one matters', () => {
    for (const level of ['normal', 'compact', 'dense'] as const) {
      const def = renderHook(() => useTableDensity(level));
      const wide = renderHook(() => useTableDensity(level, 'wide'));
      expect(wide.result.current.cellPadding, level).not.toBe(def.result.current.cellPadding);
    }
  });

  it('defaults to the default scale when none is named', () => {
    const implicit = renderHook(() => useTableDensity('normal'));
    const explicit = renderHook(() => useTableDensity('normal', 'default'));
    expect(implicit.result.current).toEqual(explicit.result.current);
  });
});

describe('nextDensity', () => {
  it('cycles normal → compact', () => {
    expect(nextDensity('normal')).toBe('compact');
  });

  it('cycles compact → dense', () => {
    expect(nextDensity('compact')).toBe('dense');
  });

  it('cycles dense → normal', () => {
    expect(nextDensity('dense')).toBe('normal');
  });
});
