'use client';

import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useViewDefault } from '@/hooks/useViewDefault';
import { BUILT_IN_VIEW_DEFAULTS } from '@/lib/view-defaults';
import { createLogger } from '@/lib/logger';

const logger = createLogger('TransactionsPanels');

/**
 * The foldable panels above the Transactions register: the chart band (the
 * chart and any info widget beside it, folded together into one strip) and
 * each kind of info widget on its own.
 */
export type TransactionsPanel = 'chart' | 'accountWidget' | 'payeeWidget' | 'categoryWidget';

/**
 * Where this browser remembers each panel's state. The three widget keys
 * predate the chart's and are kept so nobody's saved state is lost. A key is
 * written only when the user folds or unfolds the panel, so an absent key
 * means this browser has made no choice and the account default applies.
 */
export const TRANSACTIONS_PANEL_STORAGE_KEYS: Readonly<Record<TransactionsPanel, string>> = {
  chart: 'monize-transactions-chart-collapsed',
  accountWidget: 'monize-transactions-account-widget-collapsed',
  payeeWidget: 'monize-transactions-payee-widget-collapsed',
  categoryWidget: 'monize-transactions-category-widget-collapsed',
};

/**
 * Whether a panel is folded, and a setter that remembers the choice in this
 * browser. This browser's choice wins; without one the account's default
 * (`chartCollapsed` for the chart, `widgetsCollapsed` for every widget)
 * applies; without that the panel starts open.
 */
export function useTransactionsPanelCollapsed(
  panel: TransactionsPanel,
): [boolean, (collapsed: boolean) => void] {
  const [stored, setStored] = useLocalStorage<unknown>(
    TRANSACTIONS_PANEL_STORAGE_KEYS[panel],
    null,
  );
  const key = panel === 'chart' ? 'chartCollapsed' : 'widgetsCollapsed';
  const accountDefault = useViewDefault(key);

  // A hand-edited entry that is not a boolean reads as no choice rather than
  // as a truthy string folding the panel.
  const collapsed =
    typeof stored === 'boolean' ? stored : (accountDefault ?? BUILT_IN_VIEW_DEFAULTS[key]);

  return [collapsed, setStored];
}

/**
 * Forget this browser's choice for every panel, so the account defaults apply
 * the next time the Transactions page mounts.
 */
export function clearTransactionsPanelChoices(): void {
  for (const key of Object.values(TRANSACTIONS_PANEL_STORAGE_KEYS)) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      logger.warn(`Error clearing localStorage key "${key}":`, error);
    }
  }
}
