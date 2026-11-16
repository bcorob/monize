import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import {
  useDateDisplayStore,
  useCompactMobileDates,
  resolveCompactMobileDates,
  DATE_DISPLAY_STORAGE_KEY,
} from './dateDisplayStore';
import { usePreferencesStore } from './preferencesStore';
import type { UserPreferences } from '@/types/auth';

describe('dateDisplayStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useDateDisplayStore.setState({ compactMobileDates: false });
    usePreferencesStore.setState({ preferences: null });
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

    // persist writes on set(), never on hydration, so a stored false (from
    // before `null` existed or after) is a user who switched the year back on:
    // a choice the account default must not override.
    it('keeps a stored false', async () => {
      useDateDisplayStore.setState({ compactMobileDates: true });
      expect(await rehydrateWith(false)).toBe(false);
    });

    it('keeps a stored null as no choice', async () => {
      expect(await rehydrateWith(null)).toBeNull();
    });

    it('reads a corrupted value as no choice instead of adopting it', async () => {
      expect(await rehydrateWith('enormous')).toBeNull();
    });

    it('survives a missing field', async () => {
      window.localStorage.setItem(
        DATE_DISPLAY_STORAGE_KEY,
        JSON.stringify({ state: {}, version: 0 }),
      );
      await useDateDisplayStore.persist.rehydrate();
      expect(useDateDisplayStore.getState().compactMobileDates).toBeNull();
    });


    it('keeps the action callable afterwards', async () => {
      await rehydrateWith(true);
      useDateDisplayStore.getState().toggleCompactMobileDates();

      expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
    });
  });

  describe('the account default', () => {
    const setAccountDefault = (viewDefaults: unknown) =>
      usePreferencesStore.setState({
        preferences: { viewDefaults } as unknown as UserPreferences,
      });

    it.each([
      [null, undefined, false],
      [null, true, true],
      [false, true, false],
      [true, false, true],
    ] as const)('resolves browser %s over account %s to %s', (local, account, expected) => {
      expect(resolveCompactMobileDates(local, account)).toBe(expected);
    });

    it('hides the year in a browser that has chosen nothing when the account says so', () => {
      useDateDisplayStore.setState({ compactMobileDates: null });
      setAccountDefault({ hideRegisterYear: true });
      const { result } = renderHook(() => useCompactMobileDates());
      expect(result.current.compactMobileDates).toBe(true);
    });

    it("keeps this browser's choice over the account default", () => {
      setAccountDefault({ hideRegisterYear: true });
      const { result } = renderHook(() => useCompactMobileDates());
      expect(result.current.compactMobileDates).toBe(false);
    });

    it('flips from the view on screen and saves the result as a choice', () => {
      useDateDisplayStore.setState({ compactMobileDates: null });
      setAccountDefault({ hideRegisterYear: true });
      const { result } = renderHook(() => useCompactMobileDates());

      act(() => result.current.toggleCompactMobileDates());

      expect(result.current.compactMobileDates).toBe(false);
      expect(useDateDisplayStore.getState().compactMobileDates).toBe(false);
    });

    it('applies again once the choice is cleared', () => {
      setAccountDefault({ hideRegisterYear: true });
      const { result } = renderHook(() => useCompactMobileDates());
      expect(result.current.compactMobileDates).toBe(false);

      act(() => useDateDisplayStore.getState().clearCompactMobileDates());

      expect(result.current.compactMobileDates).toBe(true);
    });
  });
});
