/**
 * Storage backend for attachment bytes. The metadata row lives in
 * `transaction_attachments`; the bytes live wherever the active provider puts
 * them, addressed by an opaque `key` the provider itself understands.
 *
 * DatabaseStorageProvider keeps bytes in Postgres (the default),
 * LocalStorageProvider writes them to a filesystem directory, and
 * S3StorageProvider stores them in S3-compatible object storage. Which one new
 * bytes go to is `ATTACHMENT_STORAGE_PROVIDER`; which one an existing row's bytes
 * come from is that row's own `storage_provider`, resolved through
 * `AttachmentStorageRegistry`. The two differ for exactly as long as a switch
 * takes to relocate (`AttachmentStorageMigrator`), so nothing may assume they
 * agree.
 */
export interface AttachmentStorageProvider {
  /** Stable identifier persisted in `transaction_attachments.storage_provider`. */
  readonly name: string;

  /**
   * Whether this deployment can reach this backend at all.
   *
   * Asked of the provider rather than computed by the registry, because what
   * makes a backend reachable is its own business: `database` and `local` always
   * are (a connection this process already holds, a directory it can create),
   * `s3` needs a bucket name. It says nothing about whether the endpoint is up --
   * an unreachable bucket is a failed operation, not an unaddressable provider.
   *
   * Consulted before a row's recorded provider is used to serve or relocate its
   * bytes: "configured differently" and "configured not at all" are two different
   * reports with two different repairs.
   */
  readonly addressable: boolean;

  /** Persist bytes under `key`. Joins any ambient transaction (DB provider). */
  save(key: string, data: Buffer): Promise<void>;

  /** Load the bytes stored under `key`. */
  load(key: string): Promise<Buffer>;

  /** Remove the bytes stored under `key`. Idempotent. */
  delete(key: string): Promise<void>;
}

/** DI token for the active AttachmentStorageProvider. */
export const ATTACHMENT_STORAGE_PROVIDER = Symbol(
  "ATTACHMENT_STORAGE_PROVIDER",
);
