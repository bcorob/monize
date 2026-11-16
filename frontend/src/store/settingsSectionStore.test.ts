import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SETTINGS_SECTION_DEFAULT_COLLAPSED,
  SETTINGS_SECTION_STORAGE_KEY,
  useSettingsSectionStore,
} from './settingsSectionStore';

/**
 * Load the module fresh so `persist` reads whatever the test just put in
 * localStorage. The store rehydrates once, at creation.
 */
async function reloadStore() {
  vi.resetModules();
  return (await import('./settingsSectionStore')).useSettingsSectionStore;
}

describe('settingsSectionStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsSectionStore.setState({
      collapsed: { ...SETTINGS_SECTION_DEFAULT_COLLAPSED },
    });
  });

  it('starts every section open', () => {
    // Not a coincidence to be tightened later: a section that folds itself
    // before the reader asked has to be found before it can be read.
    expect(Object.values(SETTINGS_SECTION_DEFAULT_COLLAPSED)).not.toContain(
      true,
    );
    expect(useSettingsSectionStore.getState().collapsed.push).toBe(false);
  });

  it('stores the fold under its own key, and nothing else', () => {
    useSettingsSectionStore.getState().setSectionCollapsed('push', true);

    const raw = window.localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    // The claim `persisted-storage.guard.test.ts` records is that this entry
    // names sections and never their contents. Assert the shape, so a widened
    // `partialize` fails here rather than shipping under that claim.
    expect(JSON.parse(raw!).state).toEqual({ collapsed: { push: true } });
  });

  it('reads a stored fold back on the next load', async () => {
    window.localStorage.setItem(
      SETTINGS_SECTION_STORAGE_KEY,
      JSON.stringify({ state: { collapsed: { push: true } }, version: 0 }),
    );

    const store = await reloadStore();

    expect(store.getState().collapsed.push).toBe(true);
  });

  it('falls back to the default for a value that is not a boolean', async () => {
    // A hand-edited or truncated entry must not hide a Settings section: the
    // reader would have no way to tell a fold they never made from a panel
    // that has stopped rendering.
    window.localStorage.setItem(
      SETTINGS_SECTION_STORAGE_KEY,
      JSON.stringify({ state: { collapsed: { push: 'yes' } }, version: 0 }),
    );

    const store = await reloadStore();

    expect(store.getState().collapsed.push).toBe(false);
  });

  it('drops a stored section that no longer exists', async () => {
    window.localStorage.setItem(
      SETTINGS_SECTION_STORAGE_KEY,
      JSON.stringify({
        state: { collapsed: { push: true, retiredSection: true } },
        version: 0,
      }),
    );

    const store = await reloadStore();

    expect(store.getState().collapsed).toEqual({ push: true });
  });

  it('survives an entry that is not an object at all', async () => {
    window.localStorage.setItem(
      SETTINGS_SECTION_STORAGE_KEY,
      JSON.stringify({ state: 'nonsense', version: 0 }),
    );

    const store = await reloadStore();

    expect(store.getState().collapsed).toEqual(
      SETTINGS_SECTION_DEFAULT_COLLAPSED,
    );
  });
});
