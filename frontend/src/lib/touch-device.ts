/**
 * Does this device point with a finger?
 *
 * Distinct from `useIsMobile`, which asks how WIDE the window is (639px). The
 * two answer different questions and the rule (`docs/frontend/ui-conventions.md`) is that a
 * decision about the *platform* never keys off the viewport: a narrow desktop
 * window is not a phone, and flipping platform behaviour when somebody resizes
 * a window is a bug that only ever reproduces at one width.
 *
 * `useIsMobile` stays right for choosing a LAYOUT -- the register's card rows
 * show the same figures either way. It is wrong for anything that changes what
 * a control can do.
 */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}
