import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import {
  useTransactionsPanelCollapsed,
  clearTransactionsPanelChoices,
  TRANSACTIONS_PANEL_STORAGE_KEYS,
} from './useTransactionsPanelCollapsed';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

const setAccountDefaults = (viewDefaults: unknown) =>
  usePreferencesStore.setState({
    preferences: { viewDefaults } as unknown as UserPreferences,
  });

describe('useTransactionsPanelCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({ preferences: null });
  });

  it('starts every panel open when neither the browser nor the account says otherwise', () => {
    for (const panel of ['chart', 'accountWidget', 'payeeWidget', 'categoryWidget'] as const) {
      const { result } = renderHook(() => useTransactionsPanelCollapsed(panel));
      expect(result.current[0]).toBe(false);
    }
  });

  it('keeps the widget keys the page has always used, so saved states survive', () => {
    expect(TRANSACTIONS_PANEL_STORAGE_KEYS).toEqual({
      chart: 'monize-transactions-chart-collapsed',
      accountWidget: 'monize-transactions-account-widget-collapsed',
      payeeWidget: 'monize-transactions-payee-widget-collapsed',
      categoryWidget: 'monize-transactions-category-widget-collapsed',
    });
  });

  it('folds the chart by the account default, and only the chart', () => {
    setAccountDefaults({ chartCollapsed: true });
    expect(renderHook(() => useTransactionsPanelCollapsed('chart')).result.current[0]).toBe(true);
    expect(renderHook(() => useTransactionsPanelCollapsed('payeeWidget')).result.current[0]).toBe(
      false,
    );
  });

  it('folds every widget by the one widget default, and not the chart', () => {
    setAccountDefaults({ widgetsCollapsed: true });
    for (const panel of ['accountWidget', 'payeeWidget', 'categoryWidget'] as const) {
      expect(renderHook(() => useTransactionsPanelCollapsed(panel)).result.current[0]).toBe(true);
    }
    expect(renderHook(() => useTransactionsPanelCollapsed('chart')).result.current[0]).toBe(false);
  });

  it("keeps this browser's choice over the account default", () => {
    setAccountDefaults({ chartCollapsed: true });
    window.localStorage.setItem('monize-transactions-chart-collapsed', 'false');
    expect(renderHook(() => useTransactionsPanelCollapsed('chart')).result.current[0]).toBe(false);
  });

  it('remembers a fold in this browser under the panel key', () => {
    const { result } = renderHook(() => useTransactionsPanelCollapsed('chart'));

    act(() => result.current[1](true));

    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem('monize-transactions-chart-collapsed')).toBe('true');
  });

  it('reads a hand-edited entry that is not a boolean as no choice', () => {
    // The account default is true so the result can only come from it: the
    // built-in is false, and the string itself is not a boolean.
    setAccountDefaults({ chartCollapsed: true });
    window.localStorage.setItem('monize-transactions-chart-collapsed', '"no"');
    expect(renderHook(() => useTransactionsPanelCollapsed('chart')).result.current[0]).toBe(true);
  });

  it('forgets every panel choice, so the account defaults apply on the next mount', () => {
    for (const key of Object.values(TRANSACTIONS_PANEL_STORAGE_KEYS)) {
      window.localStorage.setItem(key, 'false');
    }
    window.localStorage.setItem('unrelated', 'kept');
    setAccountDefaults({ chartCollapsed: true, widgetsCollapsed: true });

    clearTransactionsPanelChoices();

    for (const key of Object.values(TRANSACTIONS_PANEL_STORAGE_KEYS)) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
    expect(window.localStorage.getItem('unrelated')).toBe('kept');
    expect(renderHook(() => useTransactionsPanelCollapsed('chart')).result.current[0]).toBe(true);
  });
});
