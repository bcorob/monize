import { ConflictException } from "@nestjs/common";
import { EntityManager, DataSource, IsNull } from "typeorm";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";
import { affectedRowCount, returnedRows } from "../../common/db/query-result";
import { tr } from "../../i18n/translate";
import { AttachmentBlobTombstone } from "../entities/attachment-blob-tombstone.entity";

/**
 * The protocol for writing attachment bytes nothing references yet.
 *
 * A tombstone row means "these bytes may exist at (provider, key) and nothing
 * references them", which is equally true of an upload in flight and of a
 * metadata row that is gone -- one row shape, one sweeper (audit FV4-003). The
 * three statements here are the writer's half of it, and they are in their own
 * file because there are now three writers: `AttachmentsService.create`, which puts
 * the bytes of a new attachment, `AttachmentStorageMigrator`, which puts a
 * copy of an existing attachment's bytes in the backend a switch moved to, and
 * `BackupAttachmentTransferService`, which stages the objects of a restore before
 * the restore transaction commits. The
 * fences below are subtle enough that a second hand-rolled copy is the likelier
 * defect than any of the code they guard.
 *
 * The `database` provider never takes an intent: its bytes are a row in
 * `attachment_blobs` that commits and rolls back with the metadata, so there is
 * no window for anything to be orphaned in. That check lives here rather than at
 * each call site, because it is a property of the provider.
 */

/**
 * How long a writer owns the key it is about to write.
 *
 * A *latency* mechanism, not the safety one: it keeps the orphan sweep away from
 * a write that is probably still running, so the fence in `clearObjectIntent`
 * stays a safety net rather than a routine source of failures. Correctness does
 * not depend on the value being right, which is the whole difference from the age
 * check it replaced (audit RV4-002).
 */
export const UPLOAD_INTENT_LEASE_MS = 15 * 60 * 1000;

/**
 * The sweeper claimed this write's object before the metadata could commit.
 *
 * Thrown inside that transaction, so it rolls back -- the alternative is a
 * committed attachment row whose bytes have been deleted, which a successful 201
 * makes invisible until someone tries to download their receipt.
 *
 * A `ConflictException`, because a lost race is what happened and retrying is what
 * the client should do. As a bare `Error` this escaped `create` as a 500 carrying
 * an untranslated internal message -- neither of which is true of it. The storage
 * key stays a property rather than going in the message: it is a diagnostic, and
 * the client has no use for it.
 */
export class AttachmentObjectSweptError extends ConflictException {
  constructor(readonly storageKey: string) {
    super(
      tr(
        "errors.attachments.swept",
        "The upload took too long and its storage was reclaimed. Please try again.",
      ),
    );
    this.name = "AttachmentObjectSweptError";
  }
}

/**
 * Record that bytes are about to be written at `(provider, storageKey)`, and
 * commit it.
 *
 * What keeps the sweeper off a write still in progress is the lease this row
 * carries, not its age: nothing bounds a write to a window, so an age check
 * deletes the bytes of any write that outlives the guess.
 *
 * `runOutsideActiveScopedManager` because the caller may itself be inside a
 * transaction: joining it would make the intent roll back with the work it exists
 * to outlive.
 *
 * The conflict arm deliberately does **not** clear `swept_at`. Resurrecting a
 * claimed row would un-fence the sweeper's claim -- and a claimed row may be
 * inside its late-write quarantine, in which case bytes are pending deletion at
 * that key. Refusing is the only answer that stays true whoever writes the key
 * next.
 */
export async function recordObjectIntent(
  dataSource: DataSource,
  provider: string,
  storageKey: string,
  userId: string | null,
  leaseMs: number = UPLOAD_INTENT_LEASE_MS,
): Promise<void> {
  if (provider === "database") return;
  const claimed = await runOutsideActiveScopedManager(() =>
    withScopedDb(dataSource, (m) =>
      m.query(
        `INSERT INTO attachment_blob_tombstones
             (user_id, storage_provider, storage_key, upload_lease_expires_at)
           VALUES ($1, $2, $3,
                   CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval)
           ON CONFLICT (storage_provider, storage_key)
           DO UPDATE SET upload_lease_expires_at = EXCLUDED.upload_lease_expires_at
             WHERE attachment_blob_tombstones.swept_at IS NULL
           RETURNING id`,
        [userId, provider, storageKey, String(leaseMs)],
      ),
    ),
  );
  // An `INSERT` comes back as bare rows whatever the RETURNING, so this is
  // `returnedRows` and not a length check on a shape nobody confirmed.
  if (returnedRows<{ id: string }>(claimed).length === 0) {
    throw new AttachmentObjectSweptError(storageKey);
  }
}

/**
 * Drop the intent inside the caller's transaction, so it commits with the row
 * that now owns the bytes -- and refuse if the sweeper has already claimed the
 * object.
 *
 * `swept_at IS NULL` is the fence. The sweeper sets it before deleting the bytes,
 * and this statement contends for the same row, so PostgreSQL admits only two
 * outcomes: this transaction clears the intent and commits metadata for bytes that
 * are still there, or the sweeper claimed first and this throws and rolls back. A
 * committed metadata row pointing at deleted bytes -- which the previous age-only
 * check permitted whenever a write outlived the grace window -- is not reachable
 * (audit RV4-002).
 */
export async function clearObjectIntent(
  m: EntityManager,
  provider: string,
  storageKey: string,
): Promise<void> {
  if (provider === "database") return;
  const cleared = await m.query(
    `DELETE FROM attachment_blob_tombstones
        WHERE storage_provider = $1 AND storage_key = $2 AND swept_at IS NULL
        RETURNING id`,
    [provider, storageKey],
  );
  if (affectedRowCount(cleared) === 0) {
    throw new AttachmentObjectSweptError(storageKey);
  }
}

/**
 * Drop the intent in its own transaction, when there is no work to bind it to.
 *
 * Fenced on `swept_at` for the same reason `clearObjectIntent` is, and it is not
 * the same reason. That one protects *metadata*; this one protects the *record*. A
 * claimed row may be inside its late-write quarantine -- the sweeper deleted a key
 * where a stalled put had not yet landed, and keeps the row so the next pass
 * re-deletes it (audit RRV4-002). This runs in the `catch` of a write, including
 * the arm where `save` itself threw: an aborted put destroys the socket but cannot
 * prove the endpoint discarded a body it had already received. Dropping the row
 * there would throw away the only thing that can enumerate those bytes, which is
 * exactly the failure the quarantine exists for.
 *
 * So this deletes a row the sweeper has not claimed, and leaves one it has. The
 * database refuses a quarantined delete too (migration 148), but a backstop that
 * every caller relies on is not a backstop.
 */
export async function dropCommittedObjectIntent(
  dataSource: DataSource,
  provider: string,
  storageKey: string,
  onFailure: (message: string) => void,
): Promise<void> {
  if (provider === "database") return;
  await runOutsideActiveScopedManager(() =>
    withScopedDb(dataSource, (m) =>
      m.getRepository(AttachmentBlobTombstone).delete({
        storageProvider: provider,
        storageKey,
        sweptAt: IsNull(),
      }),
    ),
  ).catch((error: unknown) =>
    onFailure(error instanceof Error ? error.message : String(error)),
  );
}
