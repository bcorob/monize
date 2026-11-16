import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FX_MAX_RATE_AGE_DAYS, isFxRateStale } from './fx-rate-age';

/**
 * The client's rate age bound is the backend's (INV-FX-001). Two bounds would
 * let a surface convert at a rate another surface refuses.
 */
const repoRoot = join(__dirname, '..', '..', '..');
const resolverSource = readFileSync(
  join(repoRoot, 'backend', 'src', 'common', 'time-series', 'fx-rate-resolver.ts'),
  'utf8',
);

describe('FX_MAX_RATE_AGE_DAYS contract', () => {
  it('equals the backend constant', () => {
    const match = /export const FX_MAX_RATE_AGE_DAYS = (\d+);/.exec(resolverSource);
    expect(match).not.toBeNull();
    expect(FX_MAX_RATE_AGE_DAYS).toBe(Number(match![1]));
  });
});

describe('isFxRateStale', () => {
  it('keeps a rate exactly at the bound and drops one day past it', () => {
    expect(isFxRateStale('2026-09-07', '2026-10-22')).toBe(false); // 45 days
    expect(isFxRateStale('2026-09-06', '2026-10-22')).toBe(true); // 46 days
  });

  it('keeps today and a future date', () => {
    expect(isFxRateStale('2026-10-22', '2026-10-22')).toBe(false);
    expect(isFxRateStale('2026-10-25', '2026-10-22')).toBe(false);
  });

  it('treats an unreadable date as stale', () => {
    expect(isFxRateStale('garbage', '2026-10-22')).toBe(true);
  });
});
