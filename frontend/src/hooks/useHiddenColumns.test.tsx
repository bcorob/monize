import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useHiddenColumns } from './useHiddenColumns';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';

const { storeState } = vi.hoisted(() => ({
  storeState: {
    preferences: { hiddenTableColumns: {} as Record<string, string[]> },
  },
}));

const updatePreferencesApi = vi.fn();

vi.mock('@/store/preferencesStore', () => {
  const usePreferencesStore = ((selector: (s: unknown) => unknown) =>
    selector({ preferences: storeState.preferences })) as unknown as {
    (selector: (s: unknown) => unknown): unknown;
  };
  return { usePreferencesStore };
});

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => updatePreferencesApi(...args),
  },
}));

const browserChoices = () => useHiddenColumnsStore.getState().columns;

describe('useHiddenColumns', () => {
  beforeEach(() => {
    storeState.preferences = { hiddenTableColumns: {} };
    updatePreferencesApi.mockReset();
  });

  it('reads the account default for a kind this browser has not chosen, dropping unknown ids', () => {
    storeState.preferences = {
      hiddenTableColumns: { transactions: ['tags', 'bogus'], investmentRegister: ['price'] },
    };
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect([...result.current.hidden]).toEqual(['tags']);
    expect(result.current.hideable).toEqual([
      'description',
      'refNumber',
      'tags',
      'attachments',
      'status',
    ]);
  });

  it("prefers this browser's choice over the account default", () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['tags'] } };
    useHiddenColumnsStore.setState({ columns: { transactions: ['status'] } });
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect([...result.current.hidden]).toEqual(['status']);
  });

  it("treats this browser's empty choice as show everything, not as no choice", () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['tags'] } };
    useHiddenColumnsStore.setState({ columns: { transactions: [] } });
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect(result.current.hidden.size).toBe(0);
  });

  it('treats a missing map as nothing hidden', () => {
    storeState.preferences = {} as typeof storeState.preferences;
    const { result } = renderHook(() => useHiddenColumns('investmentHoldings'));
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.isVisible('shares')).toBe(true);
  });

  it('isVisible is false for a hidden id and true for a structural one', () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['status'] } };
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect(result.current.isVisible('status')).toBe(false);
    expect(result.current.isVisible('category')).toBe(true);
    expect(result.current.isVisible('amount')).toBe(true);
  });

  it('keeps isVisible stable across renders while the entry is unchanged', () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['status'] } };
    const { result, rerender } = renderHook(() => useHiddenColumns('transactions'));
    const first = result.current.isVisible;
    rerender();
    expect(result.current.isVisible).toBe(first);
  });

  it('hides into this browser only, starting from the account default, canonicalised', () => {
    storeState.preferences = {
      hiddenTableColumns: { transactions: ['status'], investmentRegister: ['price'] },
    };
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    act(() => {
      result.current.hide('tags');
    });

    expect(browserChoices()).toEqual({ transactions: ['tags', 'status'] });
    expect([...result.current.hidden]).toEqual(['tags', 'status']);
    expect(updatePreferencesApi).not.toHaveBeenCalled();
    // The account default is untouched.
    expect(storeState.preferences.hiddenTableColumns).toEqual({
      transactions: ['status'],
      investmentRegister: ['price'],
    });
  });

  it('does not duplicate an id hidden twice', () => {
    storeState.preferences = { hiddenTableColumns: { investmentRegister: ['status'] } };
    const { result } = renderHook(() => useHiddenColumns('investmentRegister'));
    act(() => {
      result.current.hide('status');
    });
    expect(browserChoices()).toEqual({ investmentRegister: ['status'] });
  });

  it('show removes one id and showAll empties the kind only', () => {
    useHiddenColumnsStore.setState({
      columns: { investmentHoldings: ['shares', 'price'], transactions: ['tags'] },
    });
    const { result } = renderHook(() => useHiddenColumns('investmentHoldings'));
    act(() => {
      result.current.show('price');
    });
    expect(browserChoices()).toEqual({ investmentHoldings: ['shares'], transactions: ['tags'] });

    act(() => {
      result.current.showAll();
    });
    expect(browserChoices()).toEqual({ investmentHoldings: [], transactions: ['tags'] });
  });

  it('persists the choice to localStorage and drops unknown kinds and ids on rehydrate', async () => {
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    act(() => {
      result.current.hide('refNumber');
    });
    expect(JSON.parse(window.localStorage.getItem('monize-hidden-columns')!)).toEqual({
      state: { columns: { transactions: ['refNumber'] } },
      version: 0,
    });

    window.localStorage.setItem(
      'monize-hidden-columns',
      JSON.stringify({
        state: { columns: { transactions: ['status', 'bogus'], nope: ['x'], investmentHoldings: 'x' } },
        version: 0,
      }),
    );
    await act(async () => {
      await useHiddenColumnsStore.persist.rehydrate();
    });
    expect(browserChoices()).toEqual({ transactions: ['status'] });
  });
});
