import {
  BACKUP_STORE_PROVIDERS,
  sharesLocation,
} from "../../backup/storage/backup-store-location";
import { jwtSecretFatalProblem } from "../jwt-secret-policy";
import {
  ENCRYPTION_KEY_ENV,
  LEGACY_ENCRYPTION_KEY_ENV,
  envReaderFromRecord,
  missingEncryptionKeyRefusal,
  resolveEncryptionKey,
} from "../encryption/encryption-key";

export { MIN_JWT_SECRET_LENGTH } from "../jwt-secret-policy";

/**
 * Cluster runtime mode: how many replicas of this process are expected to serve
 * one database.
 *
 *   - `single` : the default, and today's behaviour byte-for-byte. One replica.
 *                In-process state (throttler counters, the AI relay's live
 *                promises) is correct because there is only one process.
 *   - `multi`  : several replicas behind a load balancer with no session
 *                affinity. Anything a second replica would get wrong must be a
 *                row, so the mode is a precondition the boot checks rather
 *                than a hint. PostgreSQL is the only shared store: the
 *                throttler's counters are a table and the cross-replica
 *                wake-up is `LISTEN`/`NOTIFY`, so `multi` adds no dependency
 *                and no connection setting of its own.
 *
 * The parse-and-throw shape is `parseRlsMode` in `backend/src/common/db/rls-config.ts`: an
 * unrecognized value refuses the boot instead of silently falling back to a
 * mode the operator did not ask for.
 *
 * See `docs/specs/horizontal-scaling.md` for the work this gates.
 */
export const CLUSTER_MODES = ["single", "multi"] as const;

export type ClusterMode = (typeof CLUSTER_MODES)[number];

/** What an unset or blank `CLUSTER_MODE` means. */
export const DEFAULT_CLUSTER_MODE: ClusterMode = "single";

/**
 * DI token for the parsed mode.
 *
 * Here rather than in `cluster.module.ts` for the reason
 * `ATTACHMENT_STORAGE_PROVIDER` sits in its interface file: a consumer that
 * needs the token should not have to import a module file to get it, which is
 * how a require cycle starts (`module-graph.spec.ts`). `getClusterMode()` stays
 * the answer for code with no injector.
 */
export const CLUSTER_MODE = Symbol("CLUSTER_MODE");

/**
 * Parse and validate a raw `CLUSTER_MODE` value. Unset or blank is `single`;
 * anything else unrecognized throws.
 */
export function parseClusterMode(raw: string | undefined | null): ClusterMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") {
    return DEFAULT_CLUSTER_MODE;
  }
  if ((CLUSTER_MODES as readonly string[]).includes(value)) {
    return value as ClusterMode;
  }
  throw new Error(
    `Invalid CLUSTER_MODE "${raw}". Must be one of: ${CLUSTER_MODES.join(", ")} ` +
      "(unset defaults to single).",
  );
}

/**
 * Resolve the mode from the environment. Read fresh from `process.env` for the
 * same reason `getRlsMode` does: the answer is needed in places that have no
 * injector.
 */
export function getClusterMode(): ClusterMode {
  return parseClusterMode(process.env.CLUSTER_MODE);
}

/**
 * An operator's assertion that a container directory is one every replica
 * mounts. Compared as the string it is, per the numeric/boolean env rule.
 */
const SHARED_VOLUME_ASSERTED = "true";

/** The subset of the environment the boot matrix reads. */
export interface ClusterBootEnv {
  CLUSTER_MODE?: string;
  JWT_SECRET?: string;
  /** The at-rest encryption key; required in every mode. */
  ENCRYPTION_KEY?: string;
  /** Its former name, still accepted (and preferred where both are set). */
  AI_ENCRYPTION_KEY?: string;
  /** `database` (default), `local` or `s3`; see `attachments.module.ts`. */
  ATTACHMENT_STORAGE_PROVIDER?: string;
  /** Where the `local` provider writes. Named in the refusal, never parsed. */
  ATTACHMENT_CONTAINER_DIR?: string;
  /** The deprecated alias for the above; both name the same directory. */
  ATTACHMENT_LOCAL_DIR?: string;
  /** `true` asserts `ATTACHMENT_CONTAINER_DIR` is mounted by every replica. */
  ATTACHMENT_SHARED_VOLUME?: string;
  /** `local` (default) or `s3`; see `backup/storage/backup-store-config.ts`. */
  BACKUP_STORAGE_PROVIDER?: string;
  /** Where the `local` store writes. Named in the refusal, never parsed. */
  BACKUP_CONTAINER_DIR?: string;
  /** `true` asserts `BACKUP_CONTAINER_DIR` is mounted by every replica. */
  BACKUP_SHARED_VOLUME?: string;
  /** The `s3` store's bucket. Its presence is what makes that store usable. */
  BACKUP_STORE_S3_BUCKET?: string;
  /** The `s3` store's key prefix, for the collision check below. */
  BACKUP_STORE_S3_PREFIX?: string;
  /** The `s3` store's endpoint, for the collision check below. */
  BACKUP_STORE_S3_ENDPOINT?: string;
  /** The deployment-default OFF-MACHINE destination's bucket. A different thing. */
  BACKUP_S3_BUCKET?: string;
  /** The off-machine destination's key prefix. */
  BACKUP_S3_PREFIX?: string;
  /** The off-machine destination's endpoint. */
  BACKUP_S3_ENDPOINT?: string;
}

export interface ClusterBootReport {
  /** `null` when `CLUSTER_MODE` itself did not parse -- there is no mode to report. */
  mode: ClusterMode | null;
  /** Each reason the process must not serve traffic. Non-empty means exit. */
  refusals: readonly string[];
  /** Each thing an operator should know but that does not stop the boot. */
  warnings: readonly string[];
}

/**
 * The boot matrix, as a pure function of the environment.
 *
 * Pure so the whole table is a unit test rather than a set of container starts,
 * and so `main.ts` holds only the logging and the `process.exit`. It reports
 * every problem it finds instead of the first, because an operator restarting a
 * crash-looping container should need one restart, not one per missing
 * variable.
 *
 * What it deliberately does not cover: anything that needs a connection. In
 * `multi`, that the database host can actually hold the `LISTEN` each replica
 * keeps -- a transaction-mode pooler cannot -- is checked in `main.ts` once the
 * listener is built, because it takes a round trip.
 *
 * The storage checks below are the other half of what `multi` needs, and they
 * are assertions rather than measurements: no process can see from the inside
 * whether the directory under its mount point is the same directory another pod
 * sees. So the operator states it, and the refusal exists to make sure they
 * state it knowingly rather than discover it from a restore that cannot find
 * its bytes.
 */
export function checkClusterBoot(env: ClusterBootEnv): ClusterBootReport {
  const refusals: string[] = [];
  const warnings: string[] = [];

  let mode: ClusterMode | null = null;
  try {
    mode = parseClusterMode(env.CLUSTER_MODE);
  } catch (error) {
    refusals.push(error instanceof Error ? error.message : String(error));
  }

  // Fatal in every mode, single included. Without it `csrf.util.ts` falls back
  // to a per-process random key and `csrf.guard.ts` skips verification
  // entirely, which is a deployment that looks like it has CSRF protection and
  // has none -- and which would fail open differently on every replica. The
  // rule is `jwtSecretFatalProblem`, the one `JwtStrategy` also enforces;
  // checking it here too turns a dependency-injection stack trace into a
  // first-line log message. One shared function rather than two copies, so
  // this check can only ever refuse a deployment that was already refused
  // further in. A secret that is long enough but weak (a published
  // placeholder, a typed pattern) is deliberately NOT refused here: it boots
  // and is reported by `logJwtSecretStatus`, the admin system alert and the
  // admin banner, because replacing it has consequences the operator has to
  // plan (see `jwt-secret-policy.ts`).
  const jwtProblem = jwtSecretFatalProblem(env.JWT_SECRET);
  if (jwtProblem !== null) {
    refusals.push(
      `${jwtProblem} ` +
        "It signs every session token and derives the CSRF and OAuth cookie " +
        "keys, so a server without a secret of its own cannot protect a " +
        'request. Generate one with "openssl rand -base64 32" and set JWT_SECRET.',
    );
  }

  // Fatal in every mode too. It encrypts every secret the server keeps at rest
  // (AI provider keys, emergency-access credentials, each user's backup key,
  // the Web Push and OIDC signing keys), and a server without one used to boot,
  // store none of them and write automatic backups in plaintext.
  const encryptionKey = resolveEncryptionKey(
    envReaderFromRecord({
      [ENCRYPTION_KEY_ENV]: env.ENCRYPTION_KEY,
      [LEGACY_ENCRYPTION_KEY_ENV]: env.AI_ENCRYPTION_KEY,
    }),
  );
  if (encryptionKey === null) {
    refusals.push(missingEncryptionKeyRefusal());
  }

  if (mode === "multi") {
    // Attachments. `local` writes one file per attachment to a container path;
    // on a second pod that path is a different disk, so an upload served by one
    // replica 404s from the other. The chart mounts a ReadWriteOnce claim,
    // which a second pod on another node cannot even attach.
    const provider = (env.ATTACHMENT_STORAGE_PROVIDER ?? "database")
      .trim()
      .toLowerCase();
    const attachmentDir =
      env.ATTACHMENT_CONTAINER_DIR?.trim() ||
      env.ATTACHMENT_LOCAL_DIR?.trim() ||
      "/data/attachments";
    if (
      provider === "local" &&
      env.ATTACHMENT_SHARED_VOLUME?.trim() !== SHARED_VOLUME_ASSERTED
    ) {
      refusals.push(
        `ATTACHMENT_STORAGE_PROVIDER=local writes attachment bytes to ` +
          `${attachmentDir}, which a second replica cannot read unless every ` +
          "replica mounts that same directory (ReadWriteMany or equivalent). " +
          "Set ATTACHMENT_SHARED_VOLUME=true to assert that it does, or use " +
          "ATTACHMENT_STORAGE_PROVIDER=database (cluster-safe by " +
          "construction) or =s3.",
      );
    }
    if (provider === "database") {
      warnings.push(
        "CLUSTER_MODE=multi with ATTACHMENT_STORAGE_PROVIDER=database is " +
          "cluster-safe, and every replica reads the same bytes. Note that it " +
          "puts attachment blobs on the primary, which is a scaling concern of " +
          "a different kind: the s3 provider keeps them off it.",
      );
    }

    // Backups. Like attachments there is now a store to choose, and unlike
    // attachments there is no cluster-safe default: whether any user has
    // switched their schedule on is a row rather than an environment variable,
    // so the check can never be conditional on "is anyone using this".
    //
    // A `local` store writes to a container path, so it needs the same
    // assertion the `local` attachment provider needs. An `s3` store is
    // reachable from every replica by construction and needs none.
    const backupStore = (env.BACKUP_STORAGE_PROVIDER ?? "local")
      .trim()
      .toLowerCase();
    const backupDir = env.BACKUP_CONTAINER_DIR?.trim() || "/data/backups";
    if (
      backupStore === "local" &&
      env.BACKUP_SHARED_VOLUME?.trim() !== SHARED_VOLUME_ASSERTED
    ) {
      refusals.push(
        `CLUSTER_MODE=multi writes automatic backups to ${backupDir} on ` +
          "whichever replica runs the hourly job, and a restore served by " +
          "another replica cannot find them. Automatic backups are enabled " +
          "per user, so no setting here says whether any exist. Mount that " +
          "directory on every replica (ReadWriteMany, or a single-host volume " +
          "under docker compose, where it is shared by definition) and set " +
          "BACKUP_SHARED_VOLUME=true, or use BACKUP_STORAGE_PROVIDER=s3, " +
          "which every replica reaches by construction.",
      );
    }
  }

  // In every mode, not only `multi`: an `s3` store sharing a location with the
  // off-machine destination is wrong on one replica as much as on five.
  refusals.push(...backupStoreRefusals(env));

  return { mode, refusals, warnings };
}

/**
 * What the backup store's own configuration refuses, whatever the cluster mode.
 *
 * Two things, and the second is INV-BACKUP-007. An unrecognised
 * `BACKUP_STORAGE_PROVIDER` is refused rather than quietly read as `local`,
 * because a typo would otherwise put a deployment's recovery points on a pod's
 * disk while its operator believed they were in a bucket. And an `s3` store
 * whose bucket and prefix are the off-machine destination's is refused here, at
 * the boot, rather than at 02:00 by the first backup: the off-machine copy
 * exists to survive the loss of the store, so one bucket holding both is a
 * 3-2-1 arrangement that is actually a 1, and an operator should learn that
 * from a container that will not start rather than from a restore.
 *
 * A bucket that is not set at all is not checked here. `BACKUP_STORE_S3_BUCKET`
 * is required for an `s3` store and the store says so on its first use, with a
 * message naming the variable; duplicating that requirement in the boot matrix
 * would give the same misconfiguration two different wordings.
 */
function backupStoreRefusals(env: ClusterBootEnv): string[] {
  const configured = env.BACKUP_STORAGE_PROVIDER?.trim().toLowerCase();
  if (!configured) return [];
  if (!BACKUP_STORE_PROVIDERS.includes(configured as never)) {
    return [
      `BACKUP_STORAGE_PROVIDER=${configured} is not a backup storage target. ` +
        `Use one of: ${BACKUP_STORE_PROVIDERS.join(", ")}.`,
    ];
  }
  if (configured !== "s3") return [];

  const bucket = env.BACKUP_STORE_S3_BUCKET?.trim();
  const offsiteBucket = env.BACKUP_S3_BUCKET?.trim();
  if (!bucket || !offsiteBucket) return [];
  if (
    !sharesLocation(
      {
        bucket,
        prefix: env.BACKUP_STORE_S3_PREFIX,
        endpoint: env.BACKUP_STORE_S3_ENDPOINT,
      },
      {
        bucket: offsiteBucket,
        prefix: env.BACKUP_S3_PREFIX,
        endpoint: env.BACKUP_S3_ENDPOINT,
      },
    )
  ) {
    return [];
  }
  return [
    `BACKUP_STORE_S3_BUCKET and BACKUP_S3_BUCKET are the same location ` +
      `(bucket "${bucket}", prefixes "${env.BACKUP_STORE_S3_PREFIX ?? ""}" ` +
      `and "${env.BACKUP_S3_PREFIX ?? ""}"). The off-machine copy exists to ` +
      "survive the loss of the store, so one bucket holding both is not a " +
      "second copy (INV-BACKUP-007). Point them at different buckets, or at " +
      "non-overlapping prefixes in different buckets.",
  ];
}
