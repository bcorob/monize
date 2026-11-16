import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  formatPhoneForDisplay,
  normalizePhoneNumber,
  phoneRegionFromPreferences,
  type PhoneNormalization,
} from '@/lib/phone-number';

/**
 * The payee form validates a phone number before the request goes out, and the
 * server validates it again on the way in. A case the two answer differently is
 * either a field that blocks a number the API would have stored, or one that
 * submits a value the API then refuses -- so the rule lives as a shared truth
 * table in the backend and BOTH suites assert it, the same mechanism
 * `loan-rate-timeline.contract.test.ts` uses for the loan rate.
 *
 * A case added on either side is a case both must satisfy.
 */
const CASES_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'common',
  'phone-number-cases.json',
);

interface NormalizeCase {
  name: string;
  input: string;
  prefs: { numberFormat?: string | null; language?: string | null } | null;
  expect: PhoneNormalization;
}
interface DisplayCase {
  input: string;
  expect: string;
}
interface RegionCase {
  name: string;
  prefs: { numberFormat?: string | null; language?: string | null } | null;
  expect: string | null;
}

const table = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as {
  comment: string;
  normalize: NormalizeCase[];
  display: DisplayCase[];
  region: RegionCase[];
};

describe('phone rules, shared with the backend', () => {
  it('reads the backend truth table', () => {
    expect(table.normalize.length).toBeGreaterThan(20);
    expect(table.display.length).toBeGreaterThan(5);
    expect(table.region.length).toBeGreaterThan(5);
    expect(table.comment).toContain('E.164');
  });

  it('covers both outcomes, so neither arm can silently stop being tested', () => {
    expect(table.normalize.some((c) => c.expect.ok)).toBe(true);
    const reasons = table.normalize
      .filter((c) => !c.expect.ok)
      .map((c) => (c.expect as { reason: string }).reason);
    expect(reasons).toContain('invalid');
    expect(reasons).toContain('needs-country-code');
  });

  it.each(table.normalize)('normalizes: $name', ({ input, prefs, expect: want }) => {
    expect(normalizePhoneNumber(input, phoneRegionFromPreferences(prefs))).toEqual(want);
  });

  it.each(table.display)('displays $input as $expect', ({ input, expect: want }) => {
    expect(formatPhoneForDisplay(input)).toBe(want);
  });

  it.each(table.region)('resolves a region: $name', ({ prefs, expect: want }) => {
    expect(phoneRegionFromPreferences(prefs)).toBe(want);
  });
});

describe('formatPhoneForDisplay is total', () => {
  it('renders nothing for an absent value', () => {
    expect(formatPhoneForDisplay(null)).toBe('');
    expect(formatPhoneForDisplay(undefined)).toBe('');
    expect(formatPhoneForDisplay('')).toBe('');
  });

  it('returns a legacy value unchanged rather than blanking it', () => {
    // Rows written before this rule are not backfilled, so a value that does
    // not parse still has to reach the reader.
    expect(formatPhoneForDisplay('call the shop')).toBe('call the shop');
  });

  it('round-trips what normalization stored', () => {
    const result = normalizePhoneNumber('+44 20 7946 0958 ext. 12', null);
    if (!result.ok) throw new Error('expected a valid number');
    expect(formatPhoneForDisplay(result.stored)).toBe(result.display);
  });
});
