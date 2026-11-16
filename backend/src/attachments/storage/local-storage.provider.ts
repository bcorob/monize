import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "fs";
import { dirname, resolve, sep } from "path";
import { tr } from "../../i18n/translate";
import { shardedSegments } from "../../common/shard-path.util";
import { AttachmentStorageProvider } from "./attachment-storage.interface";
import { writeFileAtomic } from "../../backup/atomic-file";
import { assertSafeStorageKey } from "./storage-key.util";

/**
 * Folder attachment bytes are written to when ATTACHMENT_CONTAINER_DIR is unset.
 * Monize runs in a container, so this is a container path: mount a host folder
 * there (see .env.example and the docker-compose files).
 */
export const DEFAULT_ATTACHMENT_CONTAINER_DIR = "/data/attachments";

/**
 * Stores attachment bytes on the local filesystem under
 * ATTACHMENT_CONTAINER_DIR, one file per attachment named by its `key` (the
 * attachment id). Chosen by ATTACHMENT_STORAGE_PROVIDER=local -- a
 * zero-dependency alternative to Postgres BYTEA for deployments that would
 * rather keep large blobs off the database (e.g. a mounted volume) without
 * running object storage.
 *
 * Files are fanned out into two levels of subdirectory keyed by the first four
 * hex characters of the id (`<ab>/<cd>/<id>`) rather than dumped flat into a
 * single directory -- the shared layout in `common/shard-path.util.ts`, which
 * automatic backups use for their per-user folders too.
 *
 * Bytes live outside the database, but they DO travel in an application backup:
 * the export reads each object and carries it base64-encoded in
 * `attachment_blobs` (see `externalAttachmentRows`), and a restore stages
 * it back through this provider. That is what makes a backup restorable onto a
 * fresh instance, and it means this directory does not have to be backed up
 * separately. An artifact exported before that change carries only metadata, and
 * restoring one needs more than this store: the bytes are read from the CURRENT
 * instance and only after it confirms the user already owns a matching
 * `transaction_attachments` row (same id, provider, size, SHA-256), so on a fresh
 * instance every external attachment is skipped however faithfully the store was
 * restored.
 */
@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
  readonly name = "local";

  /**
   * Always: the directory is defaulted and created on demand, so there is no
   * configuration whose absence makes this backend unaddressable. An empty or
   * unmounted directory is a failed *load* of one key, which is a different
   * report -- the bytes were expected here and are not.
   */
  readonly addressable = true;

  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly baseDir: string;

  constructor(config: ConfigService) {
    // ATTACHMENT_LOCAL_DIR is the pre-rename name. Existing deployments keep
    // working on it -- ignoring it would point the provider at a different
    // folder and hide every attachment already written.
    const configured = config.get<string>("ATTACHMENT_CONTAINER_DIR");
    const legacy = config.get<string>("ATTACHMENT_LOCAL_DIR");
    if (!configured && legacy) {
      this.logger.warn(
        "ATTACHMENT_LOCAL_DIR is deprecated; rename it to ATTACHMENT_CONTAINER_DIR",
      );
    }
    this.baseDir = resolve(
      configured ?? legacy ?? DEFAULT_ATTACHMENT_CONTAINER_DIR,
    );
  }

  /**
   * Validate `key` and return it. Shared with the S3 provider (see
   * storage-key.util.ts): the rule is the same for every backend, and it lived
   * only here while the S3 path took the key unchecked.
   *
   * A key that survives this cannot contain a separator, a dot, or a NUL, so any
   * shard path derived from it stays inside `baseDir` by construction.
   */
  private safeKey(key: string): string {
    return assertSafeStorageKey(key);
  }

  /** Resolve a path inside `baseDir`, asserting containment before use. */
  private contained(...segments: string[]): string {
    const target = resolve(this.baseDir, ...segments);
    if (!target.startsWith(`${this.baseDir}${sep}`)) {
      throw new NotFoundException(
        tr("errors.attachments.notFound", "Attachment not found"),
      );
    }
    return target;
  }

  /** Sharded path for `safe`: `<baseDir>/<ab>/<cd>/<id>`. */
  private shardedPath(safe: string): string {
    return this.contained(...shardedSegments(safe));
  }

  /**
   * Flat path for `safe` -- the layout used before sharding was introduced.
   * Read and delete fall back to it so attachments written by an earlier
   * version keep resolving without a migration pass; new writes always shard.
   */
  private legacyPath(safe: string): string {
    return this.contained(safe);
  }

  async save(key: string, data: Buffer): Promise<void> {
    const target = this.shardedPath(this.safeKey(key));
    await fs.mkdir(dirname(target), { recursive: true });
    // Temp file, fsync, rename -- not `fs.writeFile` onto the final path, which
    // truncates first. A kill or an ENOSPC mid-write left a file whose bytes did
    // not match the SHA-256 the metadata row records, and nothing checked: the
    // download simply served a truncated receipt. The same hazard the automatic
    // backup had (see atomic-file.ts).
    await writeFileAtomic(target, data);
  }

  async load(key: string): Promise<Buffer> {
    const safe = this.safeKey(key);
    try {
      return await fs.readFile(this.shardedPath(safe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    // Fall back to the pre-sharding flat layout.
    try {
      return await fs.readFile(this.legacyPath(safe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundException(
          tr("errors.attachments.notFound", "Attachment not found"),
        );
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const safe = this.safeKey(key);
    // Idempotent: remove the bytes under whichever layout they were written;
    // a missing file at either path is already deleted.
    await this.unlinkIfPresent(this.shardedPath(safe));
    await this.unlinkIfPresent(this.legacyPath(safe));
  }

  private async unlinkIfPresent(target: string): Promise<void> {
    try {
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
