import { findTourAnchor } from './anchors';
import type { TourStep } from './types';

/**
 * Whether the engine can put the user on a step's screen from where they are.
 *
 * True for everything except a step pinned to a *dynamic* route: `routeMatch:
 * '/accounts/'` names an account id the tour does not know, so unless the user
 * is already on such a page -- or the step's own `route` happens to satisfy the
 * prefix, as '/reports?category=insights' does for '/reports' -- pushing
 * `route` can never make the pathname match. Left to itself the engine would
 * sit in its `navigating` phase forever behind an overlay that renders nothing,
 * which is the tour disappearing mid-run, so both callers use this instead:
 * Back refuses to land on such a step, and the engine skips it rather than
 * hanging when the user reaches it any other way (having skipped the step that
 * asks them to open the page).
 */
export function isStepReachable(step: TourStep, pathname: string): boolean {
  if (!step.routeMatch) return true;
  if (pathname.startsWith(step.routeMatch)) return true;
  return !!step.route && step.route.startsWith(step.routeMatch);
}

/** The pathname to judge reachability against when a caller has none to hand. */
function currentPathname(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

/**
 * Whether a step can be shown again right now, i.e. whether it would stay on
 * screen if Back landed on it.
 *
 * Two ways it would not:
 *  - A step waiting for something to *appear* whose target is already on the
 *    page advances again the frame it is shown -- Back onto the step that opens
 *    the transaction form, while that form is still open, would bounce straight
 *    forward and read as a dead button.
 *  - A `skipOnBack` step depends on transient UI it does not open itself (the
 *    fields of a form), so it is replayable only while that UI -- its anchor --
 *    is still on the page.
 *  - A step on a dynamic route the engine cannot construct (`isStepReachable`)
 *    is replayable only while the user is still on that route: Back onto the
 *    account-detail step from a later screen would leave the engine pushing
 *    '/accounts' at a step that only ever matches '/accounts/<id>'.
 *
 * Everything else is: a centered step needs nothing, and an ordinary anchored
 * step gets its screen navigated to and its anchor waited for.
 */
function isReplayable(step: TourStep, pathname: string): boolean {
  if (!isStepReachable(step, pathname)) return false;
  if (
    step.advance?.type === 'appear' &&
    findTourAnchor(step.advance.anchorId)
  ) {
    return false;
  }
  if (!step.skipOnBack) return true;
  return step.anchorId === null || !!findTourAnchor(step.anchorId);
}

/**
 * The step Back should land on, or null when nothing behind the current step
 * can be replayed (so Back is not offered at all).
 */
export function backTargetIndex(
  steps: readonly TourStep[],
  stepIndex: number,
  pathname: string = currentPathname(),
): number | null {
  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    if (isReplayable(steps[i], pathname)) return i;
  }
  return null;
}
