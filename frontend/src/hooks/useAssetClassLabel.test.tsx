import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { useAssetClassLabel } from './useAssetClassLabel';

describe('useAssetClassLabel', () => {
  it('names a canonical class from the translation catalog, not the server text', () => {
    const { result } = renderHook(() => useAssetClassLabel());
    // The server's English name is ignored whenever the key is known.
    expect(result.current({ assetClass: 'Stocks', assetClassKey: 'equity' })).toBe('Equities');
    expect(result.current({ assetClass: 'Bonds', assetClassKey: 'fixedIncome' })).toBe(
      'Fixed Income',
    );
  });

  it('shows a class the user typed exactly as typed', () => {
    const { result } = renderHook(() => useAssetClassLabel());
    expect(result.current({ assetClass: 'Real Estate', assetClassKey: null })).toBe('Real Estate');
  });

  it('falls back to the server name for a key this client does not know', () => {
    const { result } = renderHook(() => useAssetClassLabel());
    expect(result.current({ assetClass: 'Commodities', assetClassKey: 'commodities' })).toBe(
      'Commodities',
    );
  });
});
