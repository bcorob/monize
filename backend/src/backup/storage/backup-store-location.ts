/**
 * Where a deployment's automatic backups are kept, as pure arithmetic over
 * names: which targets exist, how a key prefix is spelled, and whether two
 * configurations point at the same place.
 *
 * Separate from `backup-store-config.ts` because the boot matrix
 * (`common/cluster/cluster-mode.ts`) needs exactly this and nothing else. That
 * file is a pure function of the environment with no imports at all, tested as a
 * table rather than as a set of container starts, and it runs in `main.ts`
 * before the Nest application exists -- so pulling the AWS SDK's transport in
 * behind it, to reach one string comparison, would cost the property that makes
 * it testable and would load a client into a process that may never make an S3
 * request. Nothing in this file imports anything.
 */

/** The targets `BACKUP_STORAGE_PROVIDER` may name. */
export const BACKUP_STORE_PROVIDERS = ["local", "s3"] as const;
export type BackupStoreProvider = (typeof BACKUP_STORE_PROVIDERS)[number];

/** Where an `s3` store puts its objects, and how it reaches them. */
export interface BackupStoreS3Config {
  readonly bucket: string;
  /** Normalised to at most one trailing slash, or `undefined` for the root. */
  readonly prefix?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Already clamped by `clampS3Deadline`; see `s3-transport.ts`. */
  readonly deadlineMs: number;
}

/**
 * A key prefix, normalised to at most one trailing slash -- the same shape
 * `S3StorageProvider` gives `ATTACHMENT_S3_PREFIX` and
 * `normalizeOffsitePrefix` gives the off-machine destination's, so an operator
 * who has configured one bucket has configured all three the same way.
 */
export function normalizeStorePrefix(
  prefix: string | null | undefined,
): string | undefined {
  if (!prefix) return undefined;
  const trimmed = prefix.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : undefined;
}

/**
 * One S3 location, for comparing a store against an off-machine destination.
 *
 * `endpoint` is part of the identity because the same bucket name on two
 * services is two places, and its absence (AWS) is a value of its own.
 */
export interface S3Location {
  readonly endpoint?: string;
  readonly bucket: string;
  readonly prefix?: string;
}

/**
 * Whether a store and an off-machine destination would write to the same place
 * (INV-BACKUP-007).
 *
 * "The same place" is broader than string equality on purpose. Two prefixes
 * where one contains the other are one place: `backups/` and `backups/store/`
 * are not separate failure domains, and the off-machine copy exists to survive
 * the loss of the store. A trailing-slash difference is not a difference at all,
 * which is why both sides are normalised before they are compared.
 *
 * An endpoint or bucket that differs makes them two places whatever the prefixes
 * say; comparing prefixes across buckets would refuse a perfectly good
 * configuration.
 */
export function sharesLocation(
  store: S3Location,
  offsite: S3Location,
): boolean {
  const sameEndpoint =
    (store.endpoint ?? "").replace(/\/+$/, "") ===
    (offsite.endpoint ?? "").replace(/\/+$/, "");
  if (!sameEndpoint || store.bucket !== offsite.bucket) return false;

  const a = normalizeStorePrefix(store.prefix) ?? "";
  const b = normalizeStorePrefix(offsite.prefix) ?? "";
  // Both carry one trailing slash (or are empty, meaning the bucket root), so a
  // containment test is a prefix test and cannot match a sibling whose name
  // merely begins the same way: `backups/` never matches `backups-old/`.
  return a.startsWith(b) || b.startsWith(a);
}
