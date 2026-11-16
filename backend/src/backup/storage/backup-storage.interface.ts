import { Readable } from "stream";

/**
 * Where a deployment's automatic backups live, as an interface with one
 * implementation selected at boot.
 *
 * `AutoBackupService` used to perform every storage operation directly on the
 * filesystem, which is why `CLUSTER_MODE=multi` had to refuse to start unless an
 * operator asserted that the backup directory was mounted by every replica: a
 * `ReadWriteOnce` claim cannot make that assertion truthfully, so `multi` and
 * automatic backups were only compatible where `ReadWriteMany` storage existed.
 * Putting the store behind a target lets the same deployment keep its recovery
 * points in an object store instead, without anything downstream of the store
 * learning that it changed.
 *
 * `docs/specs/backup-storage-targets.md` is the specification; its section 2
 * table lists the twelve storage touches this interface covers, and every member
 * here is one of them. `local` is the default and is byte-for-byte what ran
 * before the extraction.
 *
 * **What this interface deliberately does not have.** There is no `write`, only
 * `publish`: the name is INV-BACKUP-006, and a caller cannot ask for a
 * non-atomic write because no operation offers one. There is no `exists`: every
 * caller either lists or opens, and an `exists` that is checked and then acted
 * on is a race (`docs/concurrency-and-idempotency.md` says to make the act
 * itself decide). There is no path anywhere in it: `BACKUP_ALLOWED_ROOTS`,
 * `BACKUP_CONTAINER_DIR` and the whole containment model are the `local`
 * target's own concern and are meaningless to an object store.
 */

/** DI token for the active `BackupStorageTarget`. */
export const BACKUP_STORAGE_TARGET = Symbol("BACKUP_STORAGE_TARGET");

/**
 * One user's namespace within the store: opaque to everything but the target
 * that produced it.
 *
 * A string handle was the obvious shape and the wrong one. The folder string
 * this replaced was handed out of the service and joined onto by the off-site
 * retry sweep, so a value that is sometimes a directory and sometimes
 * `s3://bucket/prefix/ab/cd/uuid/` invites exactly one caller to `resolve()` it.
 * `display` carries the part a human may read; the rest is the target's, and a
 * target checks `target` before interpreting a handle it is given.
 */
export interface BackupStoreLocation {
  /** The `name` of the target that produced this handle. */
  readonly target: string;
  /** What the settings screen shows. Never parsed and never joined onto. */
  readonly display: string;
}

/**
 * One artifact the store is holding, as the store knows it: a name, a size and
 * a modification time. Tier and date are read out of the name by
 * `backup-file-names.ts`, never from any of these.
 */
export interface StoredArtifactEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
  /**
   * True for an artifact in the store's pre-namespacing layout -- one whose name
   * carries no owner, so nothing can attribute it to anybody.
   *
   * It is a property of the *store*, not of the filesystem: the `local` target
   * has such artifacts because a version before per-user folders wrote flat into
   * the base directory, and the `s3` target never returns one because it has
   * never had a layout without an owner in the key. Retention sweeps them (it is
   * how that shared history ages out); the owner-facing listing and every
   * download skip them, because offering one would hand a user another user's
   * ledger.
   */
  readonly legacy: boolean;
}

/**
 * An artifact opened for reading.
 *
 * The caller must consume the stream to its end or destroy it. An abandoned one
 * is not merely untidy: a target may open its source lazily, so a stream nobody
 * is reading reports the artifact's later disappearance as an unhandled error on
 * whatever happens to be running by then.
 */
export interface OpenedArtifact {
  readonly filename: string;
  readonly sizeBytes: number;
  /**
   * A stream rather than a buffer: the download route pipes it to the client and
   * the off-machine reader buffers it itself, and returning bytes would put a
   * whole artifact on the heap for the caller that does not need it there.
   */
  readonly stream: Readable;
}

/** Whether this deployment can write an automatic backup anywhere, and where. */
export interface BackupStoreCapability {
  readonly available: boolean;
  /** The location in display form: a directory, or a bucket and key prefix. */
  readonly location: string;
  /**
   * False when this target has no location for a user to choose or an admin to
   * browse. The settings screen hides its folder picker on it rather than
   * offering a control whose endpoints refuse.
   */
  readonly locationSelectable: boolean;
  /** Why the store is unavailable. Absent when it is available. */
  readonly reason?: string;
  /**
   * How many artifacts the **current** store holds, across every user this
   * process can see, or `undefined` when the store could not be enumerated.
   *
   * Switching a deployment from one target to another is forward-only: the
   * previous recovery points stay where they were and the new store's listing
   * cannot see them (`docs/specs/backup-storage-targets.md` section 11, decision
   * 2). This count is what makes that gap visible on the screen where an
   * operator would otherwise have to infer it.
   */
  readonly artifactCount?: number;
}

export interface BackupStorageTarget {
  /** Stable identifier: the value of `BACKUP_STORAGE_PROVIDER` that selects it. */
  readonly name: string;

  /** See `BackupStoreCapability.locationSelectable`. */
  readonly locationSelectable: boolean;

  /** The base a user who has chosen nothing is filed under, in display form. */
  readonly defaultBase: string;

  /**
   * The base this user's artifacts are filed under: their choice when the target
   * honours one, the deployment default otherwise. Never the location written
   * to -- that is `resolveLocation`, which adds the per-user namespace.
   */
  resolveBase(configured: string | null | undefined): string;

  /**
   * Normalise a base somebody is asking to store, or refuse it.
   *
   * The value arrives from a request and is persisted, so it is validated here
   * before anything keeps it -- and a target with no selectable location refuses
   * every value rather than storing one it will never read.
   */
  acceptBase(folderPath: string): string;

  /**
   * Where this user's artifacts are filed, for display on the settings screen.
   *
   * Synchronous, and `undefined` rather than a throw when the configuration
   * cannot produce one: a base an operator has since made invalid must not break
   * the settings screen, and the validation on save reports it properly.
   */
  describeLocation(
    userId: string,
    configured: string | null | undefined,
  ): string | undefined;

  /**
   * This user's namespace within the store.
   *
   * `create: true` is the write path: it makes the namespace and proves the
   * store is writable, so a deployment whose storage has gone read-only refuses
   * here rather than at 02:00. `create: false` is the read path, which creates
   * nothing -- refusing a read because the store is not writable would fail
   * exactly when somebody needs to find the backups already in it.
   */
  resolveLocation(
    userId: string,
    configured: string | null | undefined,
    opts: { create: boolean },
  ): Promise<BackupStoreLocation>;

  /**
   * Whether the store can be written to at all, without writing a backup.
   *
   * Cheap and side-effect-free beyond a probe the target removes: the per-user
   * namespace is server-computed inside a store that is already writable, so the
   * store itself is the whole of the question. `userId` is not part of that
   * question -- it is there only for `artifactCount`, which counts what this
   * store is already holding for the person reading the answer.
   */
  describeStore(
    userId: string,
    configured: string | null | undefined,
  ): Promise<BackupStoreCapability>;

  /** Admin folder validation. Refuses when `locationSelectable` is false. */
  validateFolder(
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }>;

  /** Admin folder enumeration. Refuses when `locationSelectable` is false. */
  browseFolders(
    folderPath: string,
  ): Promise<{ current: string; directories: string[] }>;

  /**
   * Make `bytes` visible under `filename`, whole or not at all (INV-BACKUP-006).
   *
   * A reader of the store sees the complete bytes under that name or no artifact
   * under it; there is no moment at which the name refers to a prefix of them,
   * and a publish that fails leaves the artifact already under that name intact.
   */
  publish(
    location: BackupStoreLocation,
    filename: string,
    bytes: Buffer,
  ): Promise<void>;

  /**
   * Copy an artifact to a second name within the same location -- the weekly and
   * monthly promotions -- with the same all-or-nothing property as `publish`.
   *
   * One operation rather than "read then publish" on purpose: on an object store
   * this is a server-side copy, and making it two would pull a whole artifact
   * through the backend to put it straight back.
   */
  promote(
    location: BackupStoreLocation,
    fromFilename: string,
    toFilename: string,
  ): Promise<void>;

  /**
   * Every artifact the store holds for this location, including the `legacy`
   * ones the target has any.
   *
   * Incomplete writes are not artifacts and never appear here: they are
   * `sweepIncomplete`'s, so retention cannot count one towards "keep 7 daily"
   * and quietly shorten the window.
   */
  list(location: BackupStoreLocation): Promise<StoredArtifactEntry[]>;

  /**
   * Open one artifact for reading, or `null` when the store holds no such name.
   *
   * `null` rather than a throw: both callers turn an absent artifact into their
   * own refusal, and the one on the download route must not be able to tell "no
   * such artifact" from "not a name we write".
   */
  open(
    location: BackupStoreLocation,
    filename: string,
  ): Promise<OpenedArtifact | null>;

  /** Delete one artifact the store listed. Idempotent. */
  remove(
    location: BackupStoreLocation,
    entry: StoredArtifactEntry,
  ): Promise<void>;

  /**
   * Discard the leftovers of interrupted writes, and report how many went.
   *
   * `now` is the clock the target judges staleness against; how long a leftover
   * must be untouched before it counts is the target's own, because only the
   * target knows what an interrupted write of its own leaves behind.
   *
   * Best-effort and never throws: it runs at the start of a backup, and failing
   * to tidy up must not stop one being taken. A target whose publish has no
   * intermediate state answers 0 -- the operation stays on the interface so the
   * caller does not branch on which target it holds.
   */
  sweepIncomplete(location: BackupStoreLocation, now: number): Promise<number>;
}
