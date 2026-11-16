/**
 * Run `callback` once the browser has left the history entry a `pushHistory`
 * Modal pushed (`components/ui/Modal.tsx` marks it `{ modal: true }`).
 *
 * A Modal closed in code pops its entry with `history.back()`, which lands
 * asynchronously, after the close has rendered. A `router.push` issued before
 * it lands is undone by it, so a navigation out of a closing modal waits for
 * the pop itself rather than a guessed delay that a slow render outlasts.
 *
 * When the current entry is not a modal's (none was pushed, or it is already
 * gone), the callback runs on the next task. If no pop arrives within
 * `ceilingMs` the callback runs anyway, so a click is never left doing nothing.
 */
export function afterModalHistoryPop(callback: () => void, ceilingMs = 1000): void {
  let done = false;
  let ceiling: number | undefined;

  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', handlePopstate);
    window.clearTimeout(ceiling);
    callback();
  };

  const onModalEntry = () =>
    (window.history.state as { modal?: unknown } | null)?.modal === true;

  // The router handles the same popstate; navigating on the next task lets
  // it settle on the entry the modal left before the push lands.
  function handlePopstate() {
    if (!onModalEntry()) window.setTimeout(finish, 0);
  }

  window.addEventListener('popstate', handlePopstate);
  ceiling = window.setTimeout(finish, ceilingMs);
  // A macrotask runs after the close has rendered and its effect has called
  // `history.back()`, but before the traversal it queued.
  window.setTimeout(() => {
    if (!onModalEntry()) finish();
  }, 0);
}
