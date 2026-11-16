import { describe, it, expect, beforeEach } from 'vitest';
import { clearBrowserViewChoices } from './browser-view-choices';
import { useDensityStore } from '@/store/densityStore';
import { useDateDisplayStore } from '@/store/dateDisplayStore';
import { TRANSACTIONS_PANEL_STORAGE_KEYS } from '@/hooks/useTransactionsPanelCollapsed';

describe('clearBrowserViewChoices', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("forgets every view choice this browser saved, and nothing else", () => {
    useDensityStore.setState({ densities: { transactions: 'dense', payees: 'compact' } });
    useDateDisplayStore.setState({ compactMobileDates: false });
    window.localStorage.setItem(TRANSACTIONS_PANEL_STORAGE_KEYS.chart, 'true');
    window.localStorage.setItem(TRANSACTIONS_PANEL_STORAGE_KEYS.payeeWidget, 'false');
    window.localStorage.setItem('monize-view-mode', '{"kept":true}');

    clearBrowserViewChoices();

    expect(useDensityStore.getState().densities).toEqual({});
    expect(useDateDisplayStore.getState().compactMobileDates).toBeNull();
    expect(window.localStorage.getItem(TRANSACTIONS_PANEL_STORAGE_KEYS.chart)).toBeNull();
    expect(window.localStorage.getItem(TRANSACTIONS_PANEL_STORAGE_KEYS.payeeWidget)).toBeNull();
    expect(window.localStorage.getItem('monize-view-mode')).toBe('{"kept":true}');
  });
});
