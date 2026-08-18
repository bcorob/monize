import { useCallback } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Density');

/**
 * Row density, per view, in one store under one key.
 *
 * It used to be thirteen stores under twelve keys: every page that showed a
 * table owned its own `useLocalStorage('monize-<view>-density')`, `AccountList`
 * hand-rolled a thirteenth under a different prefix, and three surfaces -- the
 * investment account detail register among them -- persisted nothing at all and
 * fell through to a `useState('normal')` that reset on every remount. That is
 * issue #1193: on the register the setting was never stored, and everywhere
 * else each page's copy had to be discovered and maintained separately.
 *
 * Per view is deliberate: how much fits usefully on screen depends on what the
 * table is showing, so Accounts may sit at normal while the transactions
 * register is dense. What was wrong before was not that the levels differed --
 * it was that each surface reimplemented storing them, and some forgot.
 *
 * The preference is browser-local rather than a row in `user_preferences`:
 * how many rows usefully fit is a property of the screen in front of the user,
 * so a 13" laptop and a desktop monitor signed into the same account should not
 * have to agree. Issue #1193 asks for exactly that -- "persisted in this
 * browser indefinitely".
 */
export const DENSITY_STORAGE_KEY = 'monize-density';

/**
 * Every surface that remembers a density of its own.
 *
 * A union rather than a bare `string` so a typo is a compile error instead of a
 * silently separate bucket that never matches the one the toggle writes.
 */
export type DensityView =
  | 'transactions'
  | 'bills'
  | 'accounts'
  | 'investments'
  | 'securities'
  | 'payees'
  | 'categories'
  | 'tags'
  | 'currencies'
  | 'institutions'
  | 'reports'
  | 'categoryDetail'
  | 'payeeDetail'
  | 'accountRegister'
  | 'accountFxFees'
  | 'fxFeesReport';

export const DENSITY_VIEWS: readonly DensityView[] = [
  'transactions',
  'bills',
  'accounts',
  'investments',
  'securities',
  'payees',
  'categories',
  'tags',
  'currencies',
  'institutions',
  'reports',
  'categoryDetail',
  'payeeDetail',
  'accountRegister',
  'accountFxFees',
  'fxFeesReport',
];

/**
 * The per-view keys this store replaces, each mapped to the view it belongs to
 * so an existing user's twelve separate choices all survive the upgrade intact.
 * Losing them would be the reported bug happening one final time, on the
 * release that fixes it.
 *
 * The three surfaces absent here are the ones that never persisted anything:
 * `accountRegister`, `accountFxFees` and `fxFeesReport` have nothing to carry
 * forward, which is what issue #1193 was reported against.
 */
export const LEGACY_DENSITY_KEYS: Readonly<Record<string, DensityView>> = {
  'monize-transactions-density': 'transactions',
  'accounts.filter.density': 'accounts',
  'monize-investments-density': 'investments',
  'monize-securities-density': 'securities',
  'monize-payees-density': 'payees',
  'monize-categories-density': 'categories',
  'monize-tags-density': 'tags',
  'monize-currencies-density': 'currencies',
  'monize-institutions-density': 'institutions',
  'monize-reports-density': 'reports',
  'monize-category-detail-density': 'categoryDetail',
  'monize-payee-detail-density': 'payeeDetail',
};

export const DEFAULT_DENSITY: DensityLevel = 'normal';

const DENSITY_LEVELS: readonly DensityLevel[] = ['normal', 'compact', 'dense'];

function isDensityLevel(value: unknown): value is DensityLevel {
  return typeof value === 'string' && (DENSITY_LEVELS as readonly string[]).includes(value);
}

function isDensityView(value: unknown): value is DensityView {
  return typeof value === 'string' && (DENSITY_VIEWS as readonly string[]).includes(value);
}

export type DensityMap = Partial<Record<DensityView, DensityLevel>>;

/**
 * Read every per-view key into its own bucket and clear all of them.
 *
 * Both halves matter. Reading carries each page's choice forward under the view
 * it was made on; clearing keeps localStorage from accumulating keys nothing
 * reads -- every one of which a scanner pointed at the app reports (see
 * `persisted-storage.guard.test.ts`).
 *
 * Runs at module load, before the store is created, so the result is available
 * as the initial state that `persist` then writes under the new key.
 */
export function migrateLegacyDensity(): DensityMap {
  if (typeof window === 'undefined') return {};

  const migrated: DensityMap = {};

  for (const [key, view] of Object.entries(LEGACY_DENSITY_KEYS)) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;

      window.localStorage.removeItem(key);

      // Every legacy writer went through JSON.stringify, so the stored form is
      // a quoted string. A bare value is accepted too rather than discarded --
      // it is still an unambiguous answer to what the user picked.
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON; fall through to the raw string.
      }
      if (isDensityLevel(parsed)) migrated[view] = parsed;
    } catch (error) {
      logger.warn(`Error migrating legacy density key "${key}":`, error);
    }
  }

  return migrated;
}

interface DensityState {
  densities: DensityMap;
  setDensity: (view: DensityView, density: DensityLevel) => void;
  cycleDensity: (view: DensityView) => void;
}

export const useDensityStore = create<DensityState>()(
  persist(
    (set) => ({
      densities: migrateLegacyDensity(),

      setDensity: (view, density) =>
        set((state) => ({ densities: { ...state.densities, [view]: density } })),

      cycleDensity: (view) =>
        set((state) => ({
          densities: {
            ...state.densities,
            [view]: nextDensity(state.densities[view] ?? DEFAULT_DENSITY),
          },
        })),
    }),
    {
      name: DENSITY_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The actions are recreated on load; only the levels are worth storing.
      partialize: (state) => ({ densities: state.densities }),
      // A hand-edited or truncated entry is not a reason to render a broken
      // table, and a view that no longer exists is not a reason to keep a
      // bucket nothing can ever read -- drop both rather than trust the string.
      merge: (persisted, current) => {
        const stored = (persisted as { densities?: unknown } | undefined)?.densities;
        const densities: DensityMap = {};

        if (stored && typeof stored === 'object') {
          for (const [view, level] of Object.entries(stored)) {
            if (isDensityView(view) && isDensityLevel(level)) densities[view] = level;
          }
        }

        return { ...current, densities };
      },
    }
  )
);

/**
 * The one way a surface reads and changes its own row density.
 *
 * Pass the view whose level you want. Selectors are subscribed individually so
 * a component re-renders when *its* level moves and not when another view's
 * does, and `setDensity`/`cycleDensity` are bound to the view so a caller
 * cannot write to the wrong bucket by forgetting an argument.
 */
export function useDensityPreference(view: DensityView) {
  const density = useDensityStore((state) => state.densities[view] ?? DEFAULT_DENSITY);
  const setForView = useDensityStore((state) => state.setDensity);
  const cycleForView = useDensityStore((state) => state.cycleDensity);

  const setDensity = useCallback(
    (level: DensityLevel) => setForView(view, level),
    [setForView, view],
  );
  const cycleDensity = useCallback(() => cycleForView(view), [cycleForView, view]);

  return { density, setDensity, cycleDensity };
}
