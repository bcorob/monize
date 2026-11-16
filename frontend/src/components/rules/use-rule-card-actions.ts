'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

export interface CardActionOptions {
  canDuplicate: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

/**
 * The overflow menu every rule card carries: duplicate, move up, move down,
 * delete. The same four verbs as the rules list, so the labels are the list's.
 */
export function useCardActions(): (options: CardActionOptions) => RowAction[] {
  const t = useTranslations('rules');
  const tc = useTranslations('common');
  return useCallback(
    (o) => [
      { key: 'duplicate', label: tc('actions.duplicate'), icon: 'duplicate', tone: 'neutral', disabled: !o.canDuplicate, onClick: o.onDuplicate },
      { key: 'moveUp', label: t('actions.moveUp'), icon: 'moveUp', tone: 'neutral', disabled: !o.canMoveUp, onClick: o.onMoveUp },
      { key: 'moveDown', label: t('actions.moveDown'), icon: 'moveDown', tone: 'neutral', disabled: !o.canMoveDown, onClick: o.onMoveDown },
      { key: 'delete', label: tc('actions.delete'), icon: 'delete', tone: 'delete', destructive: true, onClick: o.onDelete },
    ],
    [t, tc],
  );
}
