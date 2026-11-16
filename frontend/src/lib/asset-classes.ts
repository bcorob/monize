/**
 * The canonical asset classes the backend's look-through rollup returns as
 * `assetClassKey`. A copy of `ASSET_CLASS_KEYS` in
 * `backend/src/securities/security-enums.ts`, held equal to it by
 * `asset-classes.contract.test.ts`; each key is translated under
 * `investments.assetClasses`.
 */
export const ASSET_CLASS_KEYS = [
  'equity',
  'fixedIncome',
  'cash',
  'preferred',
  'convertible',
  'crypto',
] as const;

export type AssetClassKey = (typeof ASSET_CLASS_KEYS)[number];

/** True for a key this client knows how to translate. */
export function isAssetClassKey(value: unknown): value is AssetClassKey {
  return (
    typeof value === 'string' &&
    (ASSET_CLASS_KEYS as readonly string[]).includes(value)
  );
}
