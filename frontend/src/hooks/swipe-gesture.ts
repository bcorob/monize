// Low-level horizontal-swipe primitives shared by the two swipe hooks:
// `useSwipeNavigation` (pages between whole views) and `useSwipeToPaginate`
// (pages a list in place). The thresholds and the bail-out checks live here so
// the two gestures behave identically and cannot drift apart -- a swipe that
// commits a view change must feel the same as one that turns a register page.

export const DECISION_THRESHOLD = 10; // px of movement before deciding horizontal vs vertical
export const COMMIT_THRESHOLD_RATIO = 0.25; // fraction of screen width to commit
export const VELOCITY_THRESHOLD = 0.4; // px/ms -- a fast short swipe commits even if short
export const SWIPE_ANIMATION_MS = 200;

// A DOM attribute marking an element (and its subtree) as a region that pages a
// list in place. `useSwipeNavigation` treats a touch that starts inside such a
// region the way it treats a horizontally scrollable one -- it cedes the
// gesture, so the view swipe never fights the register's own pagination swipe.
export const SWIPE_PAGINATE_ATTR = 'data-swipe-paginates';

// Walk up from the touched element: a horizontally scrollable ancestor means a
// horizontal swipe is that element's to scroll, not ours to act on.
export function hasHorizontalScroll(element: EventTarget | null): boolean {
  let current = element as HTMLElement | null;
  while (current) {
    if (current.scrollWidth > current.clientWidth + 1) {
      const overflow = getComputedStyle(current).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

// A modal locks body scroll, so an open one means the gesture is not ours.
export function isModalOpen(): boolean {
  return document.body.style.overflow === 'hidden';
}

// Whether the touch started inside a pagination region (an element carrying
// `SWIPE_PAGINATE_ATTR`). Same ancestor walk as `hasHorizontalScroll`.
export function isInsidePaginationZone(element: EventTarget | null): boolean {
  let current = element as HTMLElement | null;
  while (current) {
    if (current.getAttribute?.(SWIPE_PAGINATE_ATTR) === 'true') {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
