import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GOOGLE_PLACES_CAP } from './google-places-cap';

/**
 * The cap's default and bounds are declared on the server and mirrored here.
 *
 * The two layers cannot import each other, so the mirror is checked against the
 * backend's own source -- the same arrangement `ai-query-budgets.contract.test.ts`
 * uses. A form offering a value the server rejects is worse than no form, and a
 * form refusing one the server accepts is a limit the user cannot reach.
 */
const backendSource = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'backend',
    'src',
    'payees',
    'lookup',
    'google-places',
    'google-places-cap.ts',
  ),
  'utf8',
);

function backendValue(field: string): number {
  const match = backendSource.match(
    new RegExp(`${field}:\\s*([0-9_]+)`),
  );
  if (!match) throw new Error(`backend GOOGLE_PLACES_CAP has no ${field}`);
  return Number(match[1].replace(/_/g, ''));
}

describe('GOOGLE_PLACES_CAP mirrors the backend', () => {
  it.each(['default', 'min', 'max'] as const)('agrees on %s', (field) => {
    expect(GOOGLE_PLACES_CAP[field]).toBe(backendValue(field));
  });

  it('defaults to the Text Search Enterprise SKU free allowance', () => {
    // Pinned on both sides: raising it silently would hand every deployment a
    // bill the day after an upgrade.
    expect(GOOGLE_PLACES_CAP.default).toBe(1000);
  });

  it('found a backend constant to compare against', () => {
    // A regex that matched nothing would make every assertion above vacuous.
    expect(backendSource).toContain('GOOGLE_PLACES_CAP');
  });
});
