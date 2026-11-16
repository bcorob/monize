import { usePreferencesStore } from '@/store/preferencesStore';
import { readViewDefault, type ViewDefaultKey } from '@/lib/view-defaults';

/**
 * The account's default for one view setting, or `undefined` when the account
 * sets none or preferences have not loaded yet. The map is selected whole (one
 * stable reference from the store) and read here, so a malformed value reads
 * as no default rather than reaching a component.
 */
export function useViewDefault<K extends ViewDefaultKey>(key: K) {
  const map = usePreferencesStore((state) => state.preferences?.viewDefaults);
  return readViewDefault(map, key);
}
