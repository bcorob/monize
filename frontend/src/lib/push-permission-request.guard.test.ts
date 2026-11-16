import { describe, it, expect } from 'vitest';

/**
 * `Notification.requestPermission()` lives in exactly one file.
 *
 * The rule it protects is the difference between Monize and every news site
 * that asks for notifications before you have read a sentence: the browser
 * prompt appears only behind a click, on copy that has already said what the
 * notifications are for. Called on mount -- or from an effect, or a route
 * change -- it is not merely rude, it does not work: Firefox has required a user
 * gesture since 72 and shows nothing without one, Chrome quiets the prompt for
 * origins with a poor grant rate, and iOS only shows it inside an installed web
 * app. The permission an origin loses this way cannot be asked for again.
 *
 * So the request lives in `lib/push.ts`, reached through
 * `enablePushOnThisDevice`, which every surface calls from a click handler --
 * and this scan is what says so, since prose in a `CLAUDE.md` is a rule an agent
 * agrees with and then violates anyway.
 *
 * The transient-activation reason is the same one that keeps `handleEnable`
 * non-async in both surfaces: iOS spends the click's activation on the first
 * suspension, so the request has to be the first thing the handler does.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The one file allowed to ask. It *is* the door. */
const DOOR = '/src/lib/push.ts';

/** Comments blanked: this file's own prose has to name the API it bans. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const REQUEST = /Notification\s*\.\s*requestPermission|requestPermission\s*\(/;

describe('the notification permission is requested in one place', () => {
  function offenders(): string[] {
    return Object.entries(sources)
      .filter(([path]) => path !== DOOR)
      // A test may name the API: several stub it to prove nothing calls it.
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, source]) => REQUEST.test(withoutComments(source)))
      .map(([path]) => path)
      .sort();
  }

  it('is asked for nowhere but the door', () => {
    expect(offenders()).toEqual([]);
  });

  it('still finds the door, so the rule cannot pass by accident', () => {
    const door = sources[DOOR];
    expect(door, `${DOOR} not found -- update DOOR in this test`).toBeTruthy();
    expect(REQUEST.test(withoutComments(door))).toBe(true);
  });

  // The scan reads code, so it has to be able to read code: a stripper that
  // blanked everything would make the first assertion vacuous.
  it('blanks comments without blanking code', () => {
    expect(withoutComments('// Notification.requestPermission()')).not.toMatch(
      REQUEST,
    );
    expect(
      withoutComments('/* Notification.requestPermission() */'),
    ).not.toMatch(REQUEST);
    expect(withoutComments('await Notification.requestPermission();')).toMatch(
      REQUEST,
    );
  });
});
