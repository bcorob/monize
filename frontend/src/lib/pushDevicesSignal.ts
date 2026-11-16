/**
 * Fired whenever this browser's push registrations change: a device enabled,
 * a device removed.
 *
 * Two surfaces in Settings read the same device list for different reasons --
 * `PushDevicesPanel` lists the registrations, and
 * `NotificationPreferencesMatrix` gates its push and UnifiedPush columns on
 * there being a live one, and decides whether to offer "Enable on this device"
 * from whether THIS endpoint is registered. They hold separate copies, so
 * whichever one performed the write refreshed itself and left the other stating
 * the world as it was a moment ago: enabling push from the matrix left the panel
 * below still offering to enable it, and removing the last device from the panel
 * left the matrix's push toggles enabled for a channel that could no longer
 * deliver.
 *
 * Mirrors `aiActionSignal` / `undoRedoSignal` -- direct function calls rather
 * than DOM CustomEvents, so nothing couples to the window object.
 */
const listeners = new Set<() => void>();

export function subscribePushDevices(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyPushDevicesChanged(): void {
  listeners.forEach((fn) => fn());
}
