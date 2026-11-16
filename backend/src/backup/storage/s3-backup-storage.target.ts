import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { Readable } from "stream";
import {
  buildS3Client,
  withS3Deadline,
} from "../../attachments/storage/s3-transport";
import { isShardableId, shardedSegments } from "../../common/shard-path.util";
import { tr } from "../../i18n/translate";
import { resolveDeploymentS3Target } from "../offsite/backup-offsite-config";
import {
  assertStoreAndOffsiteDiffer,
  BackupStoreS3Config,
  resolveBackupStoreS3Config,
} from "./backup-store-config";
import {
  BackupStorageTarget,
  BackupStoreCapability,
  BackupStoreLocation,
  OpenedArtifact,
  StoredArtifactEntry,
} from "./backup-storage.interface";

/**
 * How many keys one listing of a user's namespace reads.
 *
 * A namespace holds one artifact per tier per retention slot -- a few dozen at
 * the most generous settings -- so a single page is the whole of it in practice.
 * The pagination below exists anyway, because "in practice" is not a bound and a
 * truncated listing would make retention delete against a partial view.
 */
const LIST_PAGE_SIZE = 1000;

/** The `s3` handle: the key prefix one user's artifacts live under. */
interface S3BackupStoreLocation extends BackupStoreLocation {
  /** Ends with a slash. Every artifact of this user's is `${keyPrefix}${name}`. */
  readonly keyPrefix: string;
}

/**
 * Automatic backups in an S3-compatible bucket. Chosen by
 * `BACKUP_STORAGE_PROVIDER=s3`.
 *
 * **Why this exists.** The `local` target writes to a container directory, so
 * `CLUSTER_MODE=multi` has to refuse to start unless an operator asserts that
 * the directory is mounted by every replica. A Kubernetes deployment with a
 * `ReadWriteOnce` claim cannot make that assertion truthfully. An object store
 * is reachable from every replica by construction, which is what lets the boot
 * matrix accept it without the assertion.
 *
 * **The key layout is the `local` layout.** `<prefix><ab>/<cd>/<userId>/<name>`,
 * the same sharding `shardedSegments` gives attachment bytes and backup
 * directories, so `docs/adr/0003-filesystem-objects-use-id-sharding.md` still
 * describes both targets and an operator moving between them is moving the same
 * tree. Sharding is storage distribution and never authorization: what confines
 * a read to one user is the location this target is handed, which the service
 * computes from the caller's own id.
 *
 * **This is deliberately not `BackupOffsiteS3Uploader` and not
 * `S3StorageProvider`.** The off-machine uploader may add an object and must be
 * unable to remove or replace one (INV-BACKUP-004); this target is the primary
 * store, so it deletes -- that is what retention is. They share the transport
 * (`s3-transport.ts`: client construction, the aborting deadline, the retry
 * ceiling) and nothing else, which is the split that file already documents:
 * the transport is shared and the operations are not.
 */
@Injectable()
export class S3BackupStorageTarget implements BackupStorageTarget {
  readonly name = "s3";

  /**
   * A bucket and prefix are the deployment's, not a per-user choice. There is
   * no folder to pick and none to browse, so the settings screen's picker is
   * hidden rather than offered against endpoints that refuse
   * (`docs/specs/backup-storage-targets.md` section 11, decision 1).
   */
  readonly locationSelectable = false;

  private clientInstance?: S3Client;
  private configInstance?: BackupStoreS3Config;

  constructor(private readonly config: ConfigService) {}

  get defaultBase(): string {
    return this.describeBase();
  }

  /**
   * The store's configuration, resolved once on first use.
   *
   * Lazy for the reason `S3StorageProvider`'s client is: a deployment that never
   * selects `s3` pays nothing and never needs the bucket configured. The
   * store/off-machine collision is checked here rather than at construction so
   * that the refusal lands on the first backup operation with a message naming
   * both locations, and a deployment on `local` is never refused for how its
   * unused `s3` variables happen to read.
   */
  private storeConfig(): BackupStoreS3Config {
    if (this.configInstance) return this.configInstance;
    const resolved = resolveBackupStoreS3Config((name) =>
      this.config.get<string>(name),
    );
    // INV-BACKUP-007: the store and the off-machine copy are two places.
    assertStoreAndOffsiteDiffer(
      resolved,
      resolveDeploymentS3Target((name) => this.config.get<string>(name)),
    );
    this.configInstance = resolved;
    return resolved;
  }

  private client(): S3Client {
    if (this.clientInstance) return this.clientInstance;
    const store = this.storeConfig();
    this.clientInstance = buildS3Client({
      ...(store.region ? { region: store.region } : {}),
      ...(store.endpoint ? { endpoint: store.endpoint } : {}),
      forcePathStyle: store.forcePathStyle,
      ...(store.credentials ? { credentials: store.credentials } : {}),
      deadlineMs: store.deadlineMs,
    });
    return this.clientInstance;
  }

  private withDeadline<T>(
    operation: string,
    op: (options: { abortSignal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    return withS3Deadline(this.storeConfig().deadlineMs, operation, op);
  }

  /** `s3://bucket/prefix`, for the settings screen and the error messages. */
  private describeBase(): string {
    try {
      const store = this.storeConfig();
      return `s3://${store.bucket}/${store.prefix ?? ""}`;
    } catch {
      // An unconfigured store still has to describe itself: the capability
      // report says what is wrong, and a throw here would take the settings
      // screen down instead.
      return "s3://(unconfigured)";
    }
  }

  /**
   * The base is the deployment's. A stored `folderPath` is ignored rather than
   * honoured or refused here: the column may hold a directory from before this
   * deployment moved to an object store, and reading it would be honouring a
   * path that means nothing in a bucket.
   */
  resolveBase(): string {
    return this.describeBase();
  }

  /** Refuses every value: there is no location for a user to choose. */
  acceptBase(): string {
    throw new BadRequestException(
      tr(
        "errors.backup.folderNotSelectable",
        "This deployment stores automatic backups in object storage, which has no folder to choose. The location is set by the deployment's configuration.",
      ),
    );
  }

  describeLocation(userId: string): string | undefined {
    try {
      return this.displayFor(this.keyPrefixFor(userId));
    } catch {
      return undefined;
    }
  }

  async resolveLocation(userId: string): Promise<S3BackupStoreLocation> {
    const keyPrefix = this.keyPrefixFor(userId);
    // Nothing is created: an object store has no directory to make, and a
    // prefix exists exactly when an object under it does. The `create` flag the
    // interface carries is the `local` target's concern; there is no writability
    // probe to run per user either, because the bucket is the whole of the
    // question and `describeStore` asks it.
    return {
      target: this.name,
      display: this.displayFor(keyPrefix),
      keyPrefix,
    };
  }

  async describeStore(userId: string): Promise<BackupStoreCapability> {
    let location: string;
    try {
      location = this.describeBase();
      // The writability probe is a HeadBucket: it says the bucket exists and
      // this credential may reach it, without writing an object into somebody's
      // recovery points to find out.
      await this.withDeadline("HeadBucket", (options) =>
        this.client().send(
          new HeadBucketCommand({ Bucket: this.storeConfig().bucket }),
          options,
        ),
      );
    } catch (error) {
      return {
        available: false,
        location: this.describeBase(),
        locationSelectable: this.locationSelectable,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      available: true,
      location,
      locationSelectable: this.locationSelectable,
      artifactCount: await this.countArtifacts(userId),
    };
  }

  /**
   * How many artifacts this store already holds for one user, or `undefined`
   * when it cannot say.
   *
   * This is what makes a forward-only switch visible: moving a deployment from
   * `local` to `s3` leaves every previous recovery point on the old volume,
   * invisible to this listing, and a count of 0 on the settings screen is an
   * operator learning that rather than inferring it
   * (`docs/specs/backup-storage-targets.md` section 11, decision 2).
   */
  private async countArtifacts(userId: string): Promise<number | undefined> {
    try {
      const location = await this.resolveLocation(userId);
      return (await this.list(location)).length;
    } catch {
      return undefined;
    }
  }

  async validateFolder(): Promise<{ valid: boolean; error?: string }> {
    return { valid: false, error: this.notSelectableMessage() };
  }

  async browseFolders(): Promise<{ current: string; directories: string[] }> {
    throw new BadRequestException(
      tr("errors.backup.folderNotSelectable", this.notSelectableMessage()),
    );
  }

  private notSelectableMessage(): string {
    return (
      "This deployment stores automatic backups in object storage " +
      `(${this.describeBase()}), which has no folder to browse. The location ` +
      "is set by the deployment's configuration."
    );
  }

  /**
   * One `PutObject` with a known `Content-Length` and a declared
   * `ChecksumSHA256` (INV-BACKUP-006).
   *
   * S3 applies an object to its key only on a complete upload, and the declared
   * checksum makes the destination -- not this process -- verify that what
   * arrived is what was sent, so a corrupted or truncated transfer is refused
   * rather than published. That is the same mechanism the off-machine uploader
   * relies on, and it is a property of the service rather than of our code:
   * where an S3-compatible endpoint ignores the header we learn it from a
   * rejected put, not from a silent acceptance.
   *
   * Unlike the off-machine uploader there is no `IfNoneMatch`. Republishing a
   * name is intended here: a same-day re-export replaces that day's artifact
   * with the bytes the export just produced, and the run is claimed
   * (`claimDueBackup`) so two runs for one user and day cannot interleave.
   */
  async publish(
    location: BackupStoreLocation,
    filename: string,
    bytes: Buffer,
  ): Promise<void> {
    const key = this.objectKey(location, filename);
    await this.withDeadline("PutObject", (options) =>
      this.client().send(
        new PutObjectCommand({
          Bucket: this.storeConfig().bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        }),
        options,
      ),
    );
  }

  /**
   * A server-side `CopyObject`, which is likewise all-or-nothing at the
   * destination key. Reading the artifact back to put it again would pull a
   * whole backup through the backend to send it to the bucket it is already in.
   */
  async promote(
    location: BackupStoreLocation,
    fromFilename: string,
    toFilename: string,
  ): Promise<void> {
    const bucket = this.storeConfig().bucket;
    const source = this.objectKey(location, fromFilename);
    await this.withDeadline("CopyObject", (options) =>
      this.client().send(
        new CopyObjectCommand({
          Bucket: bucket,
          // The source is bucket-qualified and URI-encoded: a key contains
          // slashes, and an unencoded one is interpreted by the service rather
          // than taken literally.
          CopySource: encodeURI(`${bucket}/${source}`),
          Key: this.objectKey(location, toFilename),
        }),
        options,
      ),
    );
  }

  /**
   * Every object under this user's prefix, paged to the end.
   *
   * There are no `legacy` entries: this target has never had a layout without an
   * owner in the key, so the pre-namespacing history the `local` target sweeps
   * has no counterpart here and inventing a prefix to look in would be guessing.
   */
  async list(location: BackupStoreLocation): Promise<StoredArtifactEntry[]> {
    const { keyPrefix } = this.own(location);
    const bucket = this.storeConfig().bucket;
    const entries: StoredArtifactEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.withDeadline("ListObjectsV2", (options) =>
        this.client().send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: keyPrefix,
            MaxKeys: LIST_PAGE_SIZE,
            ...(continuationToken
              ? { ContinuationToken: continuationToken }
              : {}),
          }),
          options,
        ),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key;
        if (!key || !key.startsWith(keyPrefix)) continue;
        const name = key.slice(keyPrefix.length);
        // Only objects directly under the prefix. A key with a further slash in
        // it is not an artifact this deployment wrote, and treating it as one
        // would put a name retention could act on into the listing.
        if (!name || name.includes("/")) continue;
        entries.push({
          name,
          sizeBytes: Number(object.Size ?? 0),
          modifiedAt: object.LastModified ?? new Date(0),
          legacy: false,
        });
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return entries;
  }

  /**
   * `GetObject` on the key this location and name compose, or `null` for a key
   * the bucket does not hold.
   *
   * There is no listing to match the name against first, and none is needed: the
   * name is composed into a key that cannot leave this user's prefix
   * (`objectKey` refuses a separator), and an object store has no path to
   * traverse. A `list`-then-`get` would be a second round trip that answers a
   * question the `get` answers on its own -- and a race, since the object can go
   * between the two.
   */
  async open(
    location: BackupStoreLocation,
    filename: string,
  ): Promise<OpenedArtifact | null> {
    const key = this.objectKey(location, filename);
    try {
      return await this.withDeadline("GetObject", async (options) => {
        const result = await this.client().send(
          new GetObjectCommand({
            Bucket: this.storeConfig().bucket,
            Key: key,
          }),
          options,
        );
        const body = result.Body;
        if (!body) return null;
        return {
          filename,
          sizeBytes: Number(result.ContentLength ?? 0),
          stream: body as Readable,
        };
      });
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /** `DeleteObject` is already idempotent: deleting a missing key succeeds. */
  async remove(
    location: BackupStoreLocation,
    entry: StoredArtifactEntry,
  ): Promise<void> {
    await this.withDeadline("DeleteObject", (options) =>
      this.client().send(
        new DeleteObjectCommand({
          Bucket: this.storeConfig().bucket,
          Key: this.objectKey(location, entry.name),
        }),
        options,
      ),
    );
  }

  /**
   * Nothing to sweep. A single `PutObject` has no intermediate state: the key
   * either has the complete object or has nothing, so there is no leftover of an
   * interrupted write for this to find.
   *
   * The operation stays on the interface so the caller does not branch on which
   * target it holds.
   */

  async sweepIncomplete(): Promise<number> {
    return 0;
  }

  /** `<prefix><ab>/<cd>/<userId>/`, the `local` layout in key form. */
  private keyPrefixFor(userId: string): string {
    if (!isShardableId(userId)) {
      throw new BadRequestException(
        tr(
          "errors.backup.pathTraversal",
          `Path traversal detected: ${userId}`,
          {
            filename: userId,
          },
        ),
      );
    }
    const store = this.storeConfig();
    return `${store.prefix ?? ""}${shardedSegments(userId).join("/")}/`;
  }

  private displayFor(keyPrefix: string): string {
    return `s3://${this.storeConfig().bucket}/${keyPrefix}`;
  }

  /**
   * The bucket key for one artifact of one user's.
   *
   * The filename is refused if it carries a separator or a traversal segment.
   * An S3 prefix is a naming convention and not a boundary -- `a/b/../../c`
   * addresses `c` at the bucket root on services that normalise, and addresses a
   * literal key on those that do not, which is two different wrong answers. The
   * service already refuses a name `classifyBackupFileName` does not recognise;
   * this is the same check where the key is built, because a validated name and
   * an unchecked join is how a check becomes decorative.
   */
  private objectKey(location: BackupStoreLocation, filename: string): string {
    if (
      !filename ||
      filename.includes("/") ||
      filename.includes("\\") ||
      filename.includes("\0") ||
      filename === "." ||
      filename === ".."
    ) {
      throw new BadRequestException(
        tr(
          "errors.backup.pathTraversal",
          `Path traversal detected: ${filename}`,
          { filename },
        ),
      );
    }
    return `${this.own(location).keyPrefix}${filename}`;
  }

  /** See `LocalBackupStorageTarget.own`: a handle is opaque by contract. */
  private own(location: BackupStoreLocation): S3BackupStoreLocation {
    if (location.target !== this.name) {
      throw new Error(
        `Backup location belongs to the "${location.target}" target, not "${this.name}"`,
      );
    }
    return location as S3BackupStoreLocation;
  }

  private isNotFound(error: unknown): boolean {
    const e = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return (
      e?.name === "NoSuchKey" ||
      e?.name === "NotFound" ||
      e?.$metadata?.httpStatusCode === 404
    );
  }
}
