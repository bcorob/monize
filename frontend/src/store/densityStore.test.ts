import { describe, it, expect, beforeEach } from 'vitest';
import {
  useDensityStore,
  migrateLegacyDensity,
  LEGACY_DENSITY_KEYS,
  DENSITY_STORAGE_KEY,
  DENSITY_VIEWS,
} from './densityStore';

describe('densityStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  describe('per-view levels', () => {
    it('starts every view at normal', () => {
      const { densities } = useDensityStore.getState();
      expect(densities).toEqual({});
    });

    it('cycles one view normal -> compact -> dense -> normal', () => {
      const { cycleDensity } = useDensityStore.getState();

      cycleDensity('transactions');
      expect(useDensityStore.getState().densities.transactions).toBe('compact');
      cycleDensity('transactions');
      expect(useDensityStore.getState().densities.transactions).toBe('dense');
      cycleDensity('transactions');
      expect(useDensityStore.getState().densities.transactions).toBe('normal');
    });

    it('leaves every other view alone -- the whole point of keying by view', () => {
      const { setDensity, cycleDensity } = useDensityStore.getState();

      setDensity('accounts', 'normal');
      cycleDensity('transactions');
      cycleDensity('transactions');

      const { densities } = useDensityStore.getState();
      expect(densities.transactions).toBe('dense');
      expect(densities.accounts).toBe('normal');
    });

    it('writes the levels to localStorage', () => {
      useDensityStore.getState().setDensity('payees', 'dense');

      const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).state).toEqual({ densities: { payees: 'dense' } });
    });

    it('notifies every subscriber, so two toggles on one view cannot disagree', () => {
      const seen: (string | undefined)[] = [];
      const unsubscribe = useDensityStore.subscribe((state) =>
        seen.push(state.densities.investments),
      );

      useDensityStore.getState().setDensity('investments', 'compact');
      useDensityStore.getState().cycleDensity('investments');
      unsubscribe();

      expect(seen).toEqual(['compact', 'dense']);
    });
  });

  describe('migrating the twelve per-view keys', () => {
    it('carries each key into its own view rather than picking a winner', () => {
      window.localStorage.setItem('monize-transactions-density', JSON.stringify('dense'));
      window.localStorage.setItem('monize-tags-density', JSON.stringify('compact'));

      expect(migrateLegacyDensity()).toEqual({ transactions: 'dense', tags: 'compact' });
    });

    it("reads the account list's differently-prefixed key too", () => {
      // `accounts.filter.density` was the one key not under the `monize-`
      // prefix, and so the one most easily missed.
      window.localStorage.setItem('accounts.filter.density', JSON.stringify('compact'));

      expect(migrateLegacyDensity()).toEqual({ accounts: 'compact' });
    });

    it('clears every legacy key it read', () => {
      for (const key of Object.keys(LEGACY_DENSITY_KEYS)) {
        window.localStorage.setItem(key, JSON.stringify('dense'));
      }

      const migrated = migrateLegacyDensity();

      expect(Object.keys(migrated).sort()).toEqual(
        [...new Set(Object.values(LEGACY_DENSITY_KEYS))].sort(),
      );
      for (const key of Object.keys(LEGACY_DENSITY_KEYS)) {
        expect(window.localStorage.getItem(key), key).toBeNull();
      }
    });

    it('maps every legacy key onto a view that exists', () => {
      for (const [key, view] of Object.entries(LEGACY_DENSITY_KEYS)) {
        expect(DENSITY_VIEWS, key).toContain(view);
      }
    });

    it('accepts a bare unquoted value as well as a JSON string', () => {
      window.localStorage.setItem('monize-transactions-density', 'compact');

      expect(migrateLegacyDensity()).toEqual({ transactions: 'compact' });
    });

    it('drops a value outside the three levels rather than adopting it', () => {
      window.localStorage.setItem('monize-transactions-density', JSON.stringify('enormous'));
      window.localStorage.setItem('monize-payees-density', JSON.stringify('dense'));

      // The junk entry is skipped without taking its neighbour down with it.
      expect(migrateLegacyDensity()).toEqual({ payees: 'dense' });
      expect(window.localStorage.getItem('monize-transactions-density')).toBeNull();
    });

    it('returns an empty map when nothing was stored', () => {
      expect(migrateLegacyDensity()).toEqual({});
    });
  });

  describe('rehydrating', () => {
    const rehydrateWith = async (densities: unknown) => {
      window.localStorage.setItem(
        DENSITY_STORAGE_KEY,
        JSON.stringify({ state: { densities }, version: 0 }),
      );
      await useDensityStore.persist.rehydrate();
      return useDensityStore.getState().densities;
    };

    it('keeps stored levels', async () => {
      expect(await rehydrateWith({ accounts: 'dense', reports: 'compact' })).toEqual({
        accounts: 'dense',
        reports: 'compact',
      });
    });

    it('drops a corrupted level instead of rendering an unknown one', async () => {
      expect(await rehydrateWith({ accounts: 'gigantic', reports: 'compact' })).toEqual({
        reports: 'compact',
      });
    });

    it('drops a view that no longer exists', async () => {
      // A bucket nothing can read is dead weight in storage a scanner reports.
      expect(await rehydrateWith({ retiredPage: 'dense', reports: 'compact' })).toEqual({
        reports: 'compact',
      });
    });

    it('survives a non-object payload', async () => {
      expect(await rehydrateWith('dense')).toEqual({});
    });

    it('keeps the actions callable afterwards', async () => {
      await rehydrateWith({ tags: 'compact' });
      useDensityStore.getState().cycleDensity('tags');

      expect(useDensityStore.getState().densities.tags).toBe('dense');
    });
  });
});
