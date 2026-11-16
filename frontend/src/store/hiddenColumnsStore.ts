import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  HIDDEN_COLUMN_TABLES,
  hiddenColumnsFor,
  withHiddenColumns,
  type HiddenColumnTable,
  type HiddenTableColumns,
  type HideableColumn,
} from '@/lib/hidden-columns';

/**
 * This browser's hidden columns, one set per table kind, in one store under
 * one key.
 *
 * Browser-local for the reason density is (`densityStore`): which columns are
 * worth their width depends on the screen in front of the reader, so a phone
 * and a desktop signed into the same account should not have to agree.
 *
 * What the account holds is a *default* (the `hiddenTableColumns` preference,
 * set in Settings -> Preferences -> Default views): the set a table kind shows
 * in a browser that has saved nothing for it. A table kind absent from this map
 * is "no choice here"; an empty list is a choice to show every column, and
 * wins over the account default like any other.
 */
export const HIDDEN_COLUMNS_STORAGE_KEY = 'monize-hidden-columns';

interface HiddenColumnsState {
  columns: HiddenTableColumns;
  setHidden: <T extends HiddenColumnTable>(table: T, hidden: HideableColumn<T>[]) => void;
  /** Forget every table kind's choice, so the account defaults apply again. */
  clearHidden: () => void;
}

export const useHiddenColumnsStore = create<HiddenColumnsState>()(
  persist(
    (set) => ({
      columns: {},

      setHidden: (table, hidden) =>
        set((state) => ({ columns: withHiddenColumns(state.columns, table, hidden) })),

      clearHidden: () => set({ columns: {} }),
    }),
    {
      name: HIDDEN_COLUMNS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The actions are recreated on load; only the sets are worth storing.
      partialize: (state) => ({ columns: state.columns }),
      // A hand-edited entry, an unknown table kind or an id this client does
      // not know is dropped rather than trusted; a malformed entry for a known
      // kind reads as no choice, so the account default applies to it.
      merge: (persisted, current) => {
        const stored = (persisted as { columns?: unknown } | undefined)?.columns;
        const columns: HiddenTableColumns = {};

        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          const map = stored as HiddenTableColumns;
          for (const table of HIDDEN_COLUMN_TABLES) {
            if (Array.isArray(map[table])) columns[table] = hiddenColumnsFor(map, table);
          }
        }

        return { ...current, columns };
      },
    },
  ),
);
