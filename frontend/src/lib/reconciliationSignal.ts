/**
 * Pub/sub signal telling mounted surfaces that reconciliation state has moved.
 *
 * The header badge is a persistent reminder rendered outside every page, so it
 * fetches once when the app mounts and then never again on its own. Without a
 * signal, finishing a reconciliation leaves the count that motivated it still
 * on screen -- the user does exactly what the badge asked and the badge does
 * not notice, which reads as a broken reminder and teaches them to ignore it.
 *
 * Raised by any write that can change how many rows are outstanding: the bulk
 * reconcile itself, and the per-row status changes and deletions the reconcile
 * screen now performs. The same shape as `undoRedoSignal` -- direct function
 * calls rather than a DOM CustomEvent, so a listener cannot miss one to a
 * detached document.
 */
const listeners = new Set<() => void>();

export function subscribeReconciliation(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyReconciliationChanged(): void {
  listeners.forEach((fn) => fn());
}
