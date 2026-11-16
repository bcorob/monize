import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RESTORE_LABELS } from './restore-labels';

/**
 * The restore result dialog prints `RESTORE_LABELS[key] ?? key`, so a count key
 * the backend adds and this map does not know reaches the user as raw camelCase
 * ("notificationPreferences 3" beside properly labelled rows). Parsed from the
 * backend's own plan rather than restated, so the two cannot drift.
 */
const RESTORE_PLAN = resolve(
  __dirname,
  '../../../backend/src/backup/restore-plan.ts',
);

describe('restore result labels <-> backend restore plan', () => {
  const source = readFileSync(RESTORE_PLAN, 'utf8');
  const countKeys = [...source.matchAll(/countKey:\s*"([A-Za-z]+)"/g)].map(
    (m) => m[1],
  );

  it('still finds the plan, so the rule cannot pass by accident', () => {
    expect(countKeys.length).toBeGreaterThan(10);
  });

  it('labels every count key the restore reports', () => {
    const unlabelled = countKeys.filter((key) => !(key in RESTORE_LABELS));
    expect(unlabelled).toEqual([]);
  });

  it('carries no label for a key the restore no longer reports', () => {
    const keys = new Set(countKeys);
    const stale = Object.keys(RESTORE_LABELS).filter((key) => !keys.has(key));
    expect(stale).toEqual([]);
  });
});
