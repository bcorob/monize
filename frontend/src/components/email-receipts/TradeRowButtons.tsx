'use client';

import { RowActions, type RowAction } from '@/components/ui/row-actions';

/** The list with the entry at `index` moved one place (`by` -1 earlier, 1 later); the same list when it cannot move. */
export function moveRow<T>(rows: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (index < 0 || target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

interface TradeRowButtonsProps {
  index: number;
  count: number;
  labels: { up: string; down: string; remove: string };
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

/**
 * Earlier, later and remove for one row of an ordered list (account rules, currency markers): the first that applies wins,
 * so the order is the person's to set. The shared `RowActions` icons at compact density, as the rules list draws its own
 * move and delete actions.
 */
export function TradeRowButtons({ index, count, labels, onMove, onRemove }: TradeRowButtonsProps) {
  const actions: RowAction[] = [
    { key: 'moveUp', label: labels.up, icon: 'moveUp', tone: 'neutral', disabled: index === 0, onClick: () => onMove(-1) },
    {
      key: 'moveDown',
      label: labels.down,
      icon: 'moveDown',
      tone: 'neutral',
      disabled: index === count - 1,
      onClick: () => onMove(1),
    },
    { key: 'remove', label: labels.remove, icon: 'delete', tone: 'delete', destructive: true, onClick: onRemove },
  ];
  return <RowActions actions={actions} density="compact" />;
}
