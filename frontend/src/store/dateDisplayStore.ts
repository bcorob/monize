import { useCallback } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useViewDefault } from '@/hooks/useViewDefault';
import { BUILT_IN_VIEW_DEFAULTS } from '@/lib/view-defaults';

/**
 * Whether register surfaces drop the year from their Date columns -- the
 * day/month view, born on phone widths to free width for the payee and now a
 * view the user can choose at any width.
 *
 * One global flag rather than a per-view bucket: which date view the user
 * prefers is the same question on every register surface, so the toggle on
 * one register applies to all of them. Where it applies is the surface's
 * decision: the transaction register honours it at every width, while the
 * reconcile table only shortens below `sm`, where its columns crowd.
 *
 * The field keeps its historical `compactMobileDates` name because it is the
 * persisted shape -- renaming it would silently drop every user's saved
 * choice.
 *
 * Browser-local rather than a row in `user_preferences` for the same reason
 * row density is (see densityStore.ts): what fits on the screen in front of
 * the user is a fact about that screen, so a phone and a desktop signed into
 * the same account should not have to agree. The account holds a default
 * (the `hideRegisterYear` view default) for a browser that has chosen nothing,
 * which is what `null` records here.
 */
export const DATE_DISPLAY_STORAGE_KEY = 'monize-register-date-display';

interface DateDisplayState {
  /** This browser's choice, or `null` when it has made none. */
  compactMobileDates: boolean | null;
  /**
   * Flip the view on screen. `accountDefault` is what a browser that has
   * chosen nothing shows, so the flip is from that rather than from full dates.
   */
  toggleCompactMobileDates: (accountDefault?: boolean) => void;
  /** Forget this browser's choice, so the account default applies again. */
  clearCompactMobileDates: () => void;
}

/** This browser's choice, else the account's default, else full dates. */
export function resolveCompactMobileDates(
  local: boolean | null,
  accountDefault: boolean | undefined,
): boolean {
  return local ?? accountDefault ?? BUILT_IN_VIEW_DEFAULTS.hideRegisterYear;
}

export const useDateDisplayStore = create<DateDisplayState>()(
  persist(
    (set) => ({
      compactMobileDates: null,

      toggleCompactMobileDates: (accountDefault) =>
        set((state) => ({
          compactMobileDates: !resolveCompactMobileDates(state.compactMobileDates, accountDefault),
        })),

      clearCompactMobileDates: () => set({ compactMobileDates: null }),
    }),
    {
      name: DATE_DISPLAY_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // No migration: persist writes only on a set(), never on hydration, so
      // an entry stored before `null` existed was written by a toggle and is
      // a choice either way.
      // The action is recreated on load; only the flag is worth storing.
      partialize: (state) => ({ compactMobileDates: state.compactMobileDates }),
      // A hand-edited or truncated entry is not a reason to render a broken
      // register -- anything that is not a boolean reads as no choice.
      merge: (persisted, current) => {
        const stored = (persisted as { compactMobileDates?: unknown } | undefined)
          ?.compactMobileDates;
        return {
          ...current,
          compactMobileDates: typeof stored === 'boolean' ? stored : null,
        };
      },
    }
  )
);

/**
 * The one way a register reads and flips the mobile date shortening.
 */
export function useCompactMobileDates() {
  const local = useDateDisplayStore((state) => state.compactMobileDates);
  const accountDefault = useViewDefault('hideRegisterYear');
  const toggleForBrowser = useDateDisplayStore((state) => state.toggleCompactMobileDates);

  const compactMobileDates = resolveCompactMobileDates(local, accountDefault);
  const toggleCompactMobileDates = useCallback(
    () => toggleForBrowser(accountDefault),
    [toggleForBrowser, accountDefault],
  );

  return { compactMobileDates, toggleCompactMobileDates };
}
