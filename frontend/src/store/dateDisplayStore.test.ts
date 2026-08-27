import { describe, it, expect, beforeEach } from 'vitest';
import { useDateDisplayStore, DATE_DISPLAY_STORAGE_KEY } from './dateDisplayStore';

describe('dateDisplayStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useDateDisplayStore.setState({ compactMobileDates: false });
  });

  it('starts with full dates', () => {
    expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
  });

  it('toggles on and off', () => {
    useDateDisplayStore.getState().toggleCompactMobileDates();
    expect(useDateDisplayStore.getState().compactMobileDates).toBe(true);

    useDateDisplayStore.getState().toggleCompactMobileDates();
    expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
  });

  it('writes the flag to localStorage', () => {
    useDateDisplayStore.getState().toggleCompactMobileDates();

    const stored = window.localStorage.getItem(DATE_DISPLAY_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).state).toEqual({ compactMobileDates: true });
  });

  describe('rehydrating', () => {
    const rehydrateWith = async (compactMobileDates: unknown) => {
      window.localStorage.setItem(
        DATE_DISPLAY_STORAGE_KEY,
        JSON.stringify({ state: { compactMobileDates }, version: 0 }),
      );
      await useDateDisplayStore.persist.rehydrate();
      return useDateDisplayStore.getState().compactMobileDates;
    };

    it('keeps a stored true', async () => {
      expect(await rehydrateWith(true)).toBe(true);
    });

    it('keeps a stored false', async () => {
      useDateDisplayStore.setState({ compactMobileDates: true });
      expect(await rehydrateWith(false)).toBe(false);
    });

    it('drops a corrupted value instead of adopting it', async () => {
      expect(await rehydrateWith('enormous')).toBe(false);
    });

    it('survives a missing field', async () => {
      window.localStorage.setItem(
        DATE_DISPLAY_STORAGE_KEY,
        JSON.stringify({ state: {}, version: 0 }),
      );
      await useDateDisplayStore.persist.rehydrate();
      expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
    });

    it('keeps the action callable afterwards', async () => {
      await rehydrateWith(true);
      useDateDisplayStore.getState().toggleCompactMobileDates();

      expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
    });
  });
});
