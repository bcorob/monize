'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { Warranty } from '@/types/warranty';

interface WarrantySwitcherProps {
  /** The warranty currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Warranties to switch between. Empty until the list has loaded. */
  warranties: readonly Warranty[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the warranty's name that jumps straight to another one,
 * without going back to the list. The menu, filter and keyboard behaviour are
 * `EntitySwitcher`'s; this only says what a warranty row looks like and what
 * the filter matches.
 */
export function WarrantySwitcher({ currentId, warranties, onSelect }: WarrantySwitcherProps) {
  const t = useTranslations('warranties');

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      warranties.map((warranty) => ({
        id: warranty.id,
        primary: warranty.name,
        secondary: warranty.vendorName ?? undefined,
        // A reader reaches for the product or the shop it came from.
        searchText: `${warranty.name} ${warranty.vendorName ?? ''}`,
      })),
    [warranties],
  );

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('detail.switcher.trigger')}
      filterPlaceholder={t('detail.switcher.placeholder')}
      noMatchesLabel={t('detail.switcher.noMatches')}
      secondaryAlign="end"
    />
  );
}
