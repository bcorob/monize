'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { Budget } from '@/types/budget';

interface BudgetSwitcherProps {
  /** The budget currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Budgets to switch between. Empty until the list has loaded. */
  budgets: readonly Budget[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the budget's name that jumps straight to another one, without
 * going back to the list and clicking again. The menu, filter and keyboard
 * behaviour are `EntitySwitcher`'s; this only says what a budget row looks like.
 */
export function BudgetSwitcher({ currentId, budgets, onSelect }: BudgetSwitcherProps) {
  const t = useTranslations('budgets');

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      budgets.map((budget) => ({
        id: budget.id,
        primary: budget.name,
        secondary: t(`form.typeOptions.${budget.budgetType}`),
      })),
    [budgets, t],
  );

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('pages.detail.switchBudget')}
      filterPlaceholder={t('pages.detail.switchPlaceholder')}
      noMatchesLabel={t('pages.detail.switchNoMatches')}
      secondaryAlign="end"
    />
  );
}
