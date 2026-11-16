import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Which foldable Settings sections the reader has folded away, in one store
 * under one key.
 *
 * One store rather than one per section, for the reason `densityStore` gives:
 * thirteen surfaces each owning their own `useLocalStorage('monize-<x>')` is
 * how twelve keys came to disagree about the same question (issue #1193). The
 * next section that grows a disclosure adds a member to `SettingsSectionId`
 * and a default below -- not a second store, and not a second entry in
 * `persisted-storage.guard.test.ts`.
 *
 * Browser-local rather than a row in `user_preferences`, on the same reasoning
 * as row density and the register's date view: which panels are worth the
 * height in front of you is a fact about the screen you are reading, so a
 * phone and a desktop signed into the same account need not agree. Nothing
 * here identifies anybody -- it is one boolean per named section.
 */
export const SETTINGS_SECTION_STORAGE_KEY = 'monize-settings-sections';

/** A Settings section that can be folded away. */
export type SettingsSectionId = 'push';

/**
 * Whether each section starts folded.
 *
 * Typed as a `Record` over the union on purpose, the way `TOUR_AREA_RANK` is:
 * a new section fails type-check here rather than silently inheriting somebody
 * else's default. Every one of them is `false` today, and that is the rule
 * rather than a coincidence -- a section that hides itself before the reader
 * has asked it to is a section they have to find before they can read it.
 */
export const SETTINGS_SECTION_DEFAULT_COLLAPSED: Record<
  SettingsSectionId,
  boolean
> = {
  push: false,
};

const SETTINGS_SECTION_IDS = Object.keys(
  SETTINGS_SECTION_DEFAULT_COLLAPSED,
) as SettingsSectionId[];

interface SettingsSectionState {
  collapsed: Record<SettingsSectionId, boolean>;
  setSectionCollapsed: (
    section: SettingsSectionId,
    collapsed: boolean,
  ) => void;
}

/**
 * Read a stored map back, taking only the sections that still exist and only
 * the values that are actually booleans.
 *
 * A hand-edited, truncated or outdated entry is not a reason to render a
 * broken Settings page: anything unreadable falls back to the section's own
 * default, and a key for a section that no longer exists is dropped rather
 * than carried forward as state nothing can reach.
 */
function readStoredCollapsed(persisted: unknown): Record<SettingsSectionId, boolean> {
  const stored =
    persisted && typeof persisted === 'object'
      ? ((persisted as { collapsed?: unknown }).collapsed as
          | Record<string, unknown>
          | undefined)
      : undefined;

  return SETTINGS_SECTION_IDS.reduce(
    (acc, id) => {
      const value = stored?.[id];
      acc[id] =
        typeof value === 'boolean'
          ? value
          : SETTINGS_SECTION_DEFAULT_COLLAPSED[id];
      return acc;
    },
    {} as Record<SettingsSectionId, boolean>,
  );
}

export const useSettingsSectionStore = create<SettingsSectionState>()(
  persist(
    (set) => ({
      collapsed: { ...SETTINGS_SECTION_DEFAULT_COLLAPSED },

      setSectionCollapsed: (section, collapsed) =>
        set((state) => ({
          collapsed: { ...state.collapsed, [section]: collapsed },
        })),
    }),
    {
      name: SETTINGS_SECTION_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The action is recreated on load; only the map is worth storing.
      partialize: (state) => ({ collapsed: state.collapsed }),
      merge: (persisted, current) => ({
        ...current,
        collapsed: readStoredCollapsed(persisted),
      }),
    },
  ),
);

/**
 * The one way a Settings section reads and sets its own fold.
 *
 * The selector returns a boolean rather than the map, so a section re-renders
 * for its own fold and not for anybody else's.
 */
export function useSettingsSectionCollapsed(section: SettingsSectionId): {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
} {
  const collapsed = useSettingsSectionStore((state) => state.collapsed[section]);
  const setSectionCollapsed = useSettingsSectionStore(
    (state) => state.setSectionCollapsed,
  );

  return {
    collapsed,
    setCollapsed: (next: boolean) => setSectionCollapsed(section, next),
  };
}
