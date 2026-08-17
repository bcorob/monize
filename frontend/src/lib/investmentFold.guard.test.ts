import { describe, it, expect } from 'vitest';

/**
 * Guard for `frontend/CLAUDE.md`'s rule that the investment price / quantity /
 * total fold lives in exactly one place -- `lib/investmentFold.ts` -- so the
 * surfaces that fill those fields (the two scheduled-transaction dialogs and the
 * schedule form) cannot drift on the arithmetic. Modelled on the backend's
 * `investment-replay.guard.spec.ts`, which scans for a hand-rolled share fold
 * the same way.
 *
 * The fingerprint is the 8dp share-precision rounding (`100_000_000`): it is the
 * scale `quantityFromTotal` rounds a derived share count to, and nothing else in
 * the app rounds a number to it. A hand-rolled qty-from-total fold reintroduces
 * that constant, so a single allowed file is the whole rule. (The money side of
 * the fold rounds to `10_000`, the scale `roundMoney` uses everywhere, so it is
 * not a clean fingerprint and is deliberately not scanned here -- the share
 * count is where drift has actually bitten before.)
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The one file allowed to round a share count to 8dp -- it *is* the fold. */
const HELPER = '/src/lib/investmentFold.ts';
/**
 * 8dp share rounding, with or without the numeric separators. Anchored on both
 * sides against a digit or underscore so an unrelated billion literal
 * (`1000000000`, `1_000_000_000`) does not read as `100_000_000` and trip the
 * guard with a misleading "hand-rolled fold" failure.
 */
const SHARE_PRECISION = /(?<![\d_])100_?000_?000(?![\d_])/;

describe('the investment fold lives in lib/investmentFold.ts', () => {
  it('rounds a derived share count to 8dp in exactly one production source', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== HELPER)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, content]) => SHARE_PRECISION.test(content))
      .map(([path]) => path);

    expect(
      offenders,
      'Derive quantity from a total through quantityFromTotal() in ' +
        'lib/investmentFold.ts. A hand-rolled fold drifts from the shared ' +
        'rounding scale and the signed-commission convention -- the exact ' +
        'divergence the helper was extracted to prevent.',
    ).toEqual([]);
  });

  it('still finds the 8dp rounding in the helper, so the rule cannot pass by accident', () => {
    // Were the helper renamed, or its rounding scale changed, the scan above
    // would trivially pass over an empty set. This fails first and says what to
    // update.
    const helper = sources[HELPER];
    expect(helper, `${HELPER} not found -- update HELPER in this test`).toBeTruthy();
    expect(SHARE_PRECISION.test(helper)).toBe(true);
  });

  it('matches the fold constant but not a billion literal', () => {
    // The fingerprint must catch the share-rounding constant in either separator
    // form, and must NOT fire on an unrelated one-billion literal that merely
    // contains the same digits.
    expect(SHARE_PRECISION.test('Math.round(qty * 100_000_000) / 100_000_000')).toBe(true);
    expect(SHARE_PRECISION.test('qty * 100000000')).toBe(true);
    expect(SHARE_PRECISION.test('const LIMIT = 1_000_000_000;')).toBe(false);
    expect(SHARE_PRECISION.test('const LIMIT = 1000000000;')).toBe(false);
  });
});
