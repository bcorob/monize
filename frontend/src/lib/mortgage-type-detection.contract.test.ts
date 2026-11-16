import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MORTGAGE_TYPE_DETECTION_REASONS } from '@/types/account';
import enAccounts from '@/i18n/messages/en/accounts.json';

/**
 * The mortgage-type detector answers a reason code, not prose, so the client
 * words it in the reader's language (docs/specs/mortgage-types.md, section
 * 10). The two layers cannot import each other, so this reads the backend's
 * `MORTGAGE_TYPE_DETECTION_REASONS` from its source and holds the frontend's
 * list to it in both directions, and holds the English catalog to the list: a
 * code the server can send without a sentence here would reach the reader as
 * a missing message.
 */
const UTIL_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'accounts',
  'mortgage-type-detection.util.ts',
);

function backendReasons(): string[] {
  const source = readFileSync(UTIL_PATH, 'utf8');
  const match = source.match(
    /export const MORTGAGE_TYPE_DETECTION_REASONS = \[([\s\S]*?)\] as const;/,
  );
  if (!match) {
    throw new Error(
      `MORTGAGE_TYPE_DETECTION_REASONS not found in ${UTIL_PATH}; update this contract test with it.`,
    );
  }
  return Array.from(match[1].matchAll(/"([A-Z_]+)"/g), (m) => m[1]);
}

describe('mortgage type detection reasons', () => {
  it('lists the same reason codes as the backend, in both directions', () => {
    const backend = backendReasons();
    expect(backend.length).toBeGreaterThan(0);
    expect([...MORTGAGE_TYPE_DETECTION_REASONS].sort()).toEqual([...backend].sort());
  });

  it('words every reason code in the English catalog, and no other', () => {
    const worded = Object.keys(enAccounts.mortgageFields.detect.reason);
    expect(worded.sort()).toEqual([...MORTGAGE_TYPE_DETECTION_REASONS].sort());
  });
});
