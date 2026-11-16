import { useCallback, useMemo } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import {
  HIDEABLE_COLUMNS,
  hiddenColumnsFor,
  type HiddenColumnTable,
  type HideableColumn,
} from '@/lib/hidden-columns';

export interface UseHiddenColumnsResult<T extends HiddenColumnTable> {
  /** The table kind's hidden columns (known ids only). */
  hidden: ReadonlySet<HideableColumn<T>>;
  /** True for every column that is not hidden, structural columns included. */
  isVisible: (id: string) => boolean;
  hide: (id: HideableColumn<T>) => void;
  show: (id: HideableColumn<T>) => void;
  showAll: () => void;
  /** The kind's hideable columns, in display order. */
  hideable: readonly HideableColumn<T>[];
}

/**
 * Hidden columns of one table kind: this browser's choice
 * (`useHiddenColumnsStore`), else the account default (the
 * `hiddenTableColumns` preference, set in Settings -> Preferences), else
 * nothing hidden. Hiding or showing a column saves to this browser only; the
 * account default changes from Settings alone.
 */
export function useHiddenColumns<T extends HiddenColumnTable>(
  table: T,
): UseHiddenColumnsResult<T> {
  const local = useHiddenColumnsStore((s) => s.columns[table]);
  const accountDefault = usePreferencesStore((s) => s.preferences?.hiddenTableColumns?.[table]);
  const setHidden = useHiddenColumnsStore((s) => s.setHidden);

  // An absent browser entry is "no choice here"; an empty one is a choice to
  // show everything, and wins over the account default like any other.
  const stored = local ?? accountDefault;
  const hidden = useMemo(
    () => new Set(hiddenColumnsFor({ [table]: stored }, table)),
    [table, stored],
  );

  const isVisible = useCallback(
    (id: string) => !(hidden as ReadonlySet<string>).has(id),
    [hidden],
  );

  const hide = useCallback(
    (id: HideableColumn<T>) => setHidden(table, [...hidden, id]),
    [setHidden, table, hidden],
  );
  const show = useCallback(
    (id: HideableColumn<T>) => setHidden(table, [...hidden].filter((c) => c !== id)),
    [setHidden, table, hidden],
  );
  const showAll = useCallback(() => setHidden(table, []), [setHidden, table]);

  return {
    hidden,
    isVisible,
    hide,
    show,
    showAll,
    hideable: HIDEABLE_COLUMNS[table] as readonly HideableColumn<T>[],
  };
}
