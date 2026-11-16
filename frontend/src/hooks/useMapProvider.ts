import { usePreferencesStore } from '@/store/preferencesStore';
import type { MapProvider } from '@/lib/contact-links';

/**
 * The user's chosen map service for address links.
 *
 * A hook so the fallback is stated in one place: a component that reached into
 * the store itself would have to repeat `?? 'device'`, and the copies drift the
 * moment the default changes. Preferences load asynchronously, so this returns
 * 'device' before they arrive -- which is the same answer the app gave for
 * every user before the preference existed, so nothing flickers to a different
 * service on load.
 */
export function useMapProvider(): MapProvider {
  return (
    usePreferencesStore((state) => state.preferences?.defaultMapProvider) ??
    'device'
  );
}
