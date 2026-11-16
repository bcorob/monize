import { describe, it, expect } from 'vitest';
import { safeNotificationTarget } from './notification-target';

const ORIGIN = 'https://monize.test';

describe('safeNotificationTarget', () => {
  it('accepts a same-origin path', () => {
    expect(safeNotificationTarget('/budgets/b-1', ORIGIN)).toBe('/budgets/b-1');
    expect(safeNotificationTarget('/bills?due=today#top', ORIGIN)).toBe(
      '/bills?due=today#top',
    );
  });

  it('treats absent, empty and non-string as no target', () => {
    expect(safeNotificationTarget(null, ORIGIN)).toBeNull();
    expect(safeNotificationTarget(undefined, ORIGIN)).toBeNull();
    expect(safeNotificationTarget('', ORIGIN)).toBeNull();
    expect(safeNotificationTarget(42 as unknown as string, ORIGIN)).toBeNull();
  });

  // Each of these reaches a different origin while looking like a path to a
  // reader skimming the value.
  //
  // The whitespace ones are why this resolves instead of testing the prefix:
  // `/<tab>/evil.example` starts with ONE slash and is not `/\`, so every
  // prefix rule accepts it -- and the URL parser strips the tab and reads
  // `//evil.example`. A prefix test cannot see that; only the parser can.
  it.each([
    ['protocol-relative', '//evil.example/steal'],
    ['backslash protocol-relative', '/\\evil.example/steal'],
    ['tab then protocol-relative', '/\t/evil.example/steal'],
    ['newline then protocol-relative', '/\n/evil.example/steal'],
    ['carriage return then protocol-relative', '/\r/evil.example/steal'],
    ['tab then backslash', '/\t\\evil.example/steal'],
    ['absolute https', 'https://evil.example/steal'],
    ['scheme only', 'javascript:alert(1)'],
    ['relative', 'budgets/b-1'],
  ])('refuses a %s target', (_case, target) => {
    expect(safeNotificationTarget(target, ORIGIN)).toBeNull();
  });

  // A space is not stripped by the parser, so it stays on this origin and is
  // kept -- the rule is "same origin", not "looks tidy".
  it('keeps a path the parser leaves on this origin', () => {
    expect(safeNotificationTarget('/ /evil.example', ORIGIN)).toBe(
      '/%20/evil.example',
    );
  });

  // Refuses rather than repairs: a target we cannot vouch for is dropped, not
  // rewritten into something the producer did not mean.
  it('does not normalise a refused target into a path', () => {
    expect(safeNotificationTarget('https://evil.example/budgets/b-1', ORIGIN)).toBeNull();
  });
});
