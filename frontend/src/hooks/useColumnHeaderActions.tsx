'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { ColumnChooserItem } from '@/components/ui/ColumnChooserMenu';

interface UseColumnHeaderActionsOptions<C extends string> {
  /** The table's hideable columns with their header labels; every other id is structural. */
  columns: readonly ColumnChooserItem<C>[];
  /** Hide the column (`useHiddenColumns(...).hide`). */
  onHide: (id: C) => void;
  /**
   * A plain click or tap on the header: the sort it always did. A sortable
   * header given these handlers drops its own `onClick`, so it must pass this
   * or it would sort from the keyboard and never from a click; a table whose
   * headers do not sort (the investment register) omits it.
   */
  onHeaderClick?: (id: C) => void;
}

export interface UseColumnHeaderActionsResult {
  /**
   * The press handlers for one header: `undefined` for a structural column, so
   * a call site passes `headerHandlers('<id>')` to every header unconditionally
   * and only the hideable ones open the sheet.
   */
  headerHandlers: (id: string) => LongPressRowHandlers | undefined;
  /** The "Hide column" sheet; render it once beside the table. */
  sheet: ReactNode;
}

/**
 * The second way to hide a column: a long-press or right-click on its header
 * opens the shared row-action sheet, titled with the column, with one action.
 * Restoring is the Columns menu's alone (`ColumnChooserMenu`), which the
 * sheet's subtitle names.
 *
 * The handlers are `useLongPress`'s, so a quick click still reaches
 * `onHeaderClick` (when given) and the click that trails a long-press does
 * not; a sortable header takes them through `SortableHeader`'s
 * `pressHandlers`, a plain `<th>` spreads them.
 */
export function useColumnHeaderActions<C extends string>({
  columns,
  onHide,
  onHeaderClick,
}: UseColumnHeaderActionsOptions<C>): UseColumnHeaderActionsResult {
  const t = useTranslations('common');
  const [target, setTarget] = useState<ColumnChooserItem<C> | null>(null);

  const byId = useMemo(
    () => new Map<string, ColumnChooserItem<C>>(columns.map((column) => [column.id, column])),
    [columns],
  );

  const { getRowHandlers } = useLongPress<C>({
    onLongPress: (id) => setTarget(byId.get(id) ?? null),
    onClick: (id) => onHeaderClick?.(id),
  });

  const headerHandlers = useCallback(
    (id: string) => {
      const column = byId.get(id);
      return column ? getRowHandlers(column.id) : undefined;
    },
    [byId, getRowHandlers],
  );

  const sheet = (
    <RowActionSheet
      isOpen={target !== null}
      title={target?.label ?? ''}
      subtitle={t('columns.sheetSubtitle')}
      actions={
        target
          ? [
              {
                key: 'hide',
                label: t('columns.hideColumn'),
                icon: 'hide',
                tone: 'neutral',
                onClick: () => onHide(target.id),
              },
            ]
          : []
      }
      onClose={() => setTarget(null)}
    />
  );

  return { headerHandlers, sheet };
}
