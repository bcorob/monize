import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_LOCALES } from '@/i18n/config';
import { ASSET_CLASS_KEYS } from './asset-classes';

/**
 * The asset-class rollup's canonical keys are written once on the server and
 * translated here. A key the server adds and this copy lacks would be shown
 * under its English name in every locale; a key this copy keeps after the
 * server drops it is a label nothing can reach. Both directions are checked.
 */
const BACKEND_ENUMS = resolve(
  __dirname,
  '../../../backend/src/securities/security-enums.ts',
);

function backendKeys(): string[] {
  const source = readFileSync(BACKEND_ENUMS, 'utf8');
  const match = /export const ASSET_CLASS_KEYS = \[([^\]]*)\]/.exec(source);
  if (!match) throw new Error(`ASSET_CLASS_KEYS not found in ${BACKEND_ENUMS}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('asset-class keys', () => {
  it('match the backend list', () => {
    const keys = backendKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect([...ASSET_CLASS_KEYS]).toEqual(keys);
  });

  it('each have a label in every full locale', () => {
    const full = SUPPORTED_LOCALES.filter((l) => !l.base);
    expect(full.length).toBeGreaterThan(1);
    for (const { code } of full) {
      const catalog = JSON.parse(
        readFileSync(resolve(__dirname, `../i18n/messages/${code}/investments.json`), 'utf8'),
      );
      expect([code, Object.keys(catalog.assetClasses ?? {}).sort()]).toEqual([
        code,
        [...ASSET_CLASS_KEYS].sort(),
      ]);
    }
  });
});
