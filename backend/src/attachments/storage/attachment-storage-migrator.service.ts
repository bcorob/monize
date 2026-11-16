import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { returnedRows } from "../../common/db/query-result";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../../common/jobs/fetch-sync.service";
import { attachmentBytesConsistent } from "../../backup/attachment-integrity.util";
import { AttachmentOrphanSweeper } from "../attachment-orphan-sweeper.service";
import { AttachmentStorageProvider } from "./attachment-storage.interface";
import { AttachmentStorageRegistry } from "./attachment-storage.registry";
import {
  clearObjectIntent,
  dropCommittedObjectIntent,
  recordObjectIntent,
} from "./object-intent";

/**
 * How many attachments one pass relocates before it takes the lease again.
 *
 * Small on purpose. The lease is handed back between batches, so a long backlog
 * is a sequence of short holds rather than one hold nobody else can interrupt,
 * and a restart loses at most this much progress -- which is nothing, because
 * progress is the rows themselves.
 */
export const RELOCATION_BATCH = 25;

/**
 * How long one batch owns the job.
 *
 * Longer than a batch of puts should ever take, and it does not have to be right:
 * the lease is a cost control (one replica copying rather than N), while what
 * makes a relocation correct is per-row and inside a transaction. An expired
 * lease costs duplicated reads and writes of bytes that end up identical, never a
 * row in the wrong state.
 */
export const RELOCATION_LEASE_MS = 20 * 60 * 1000;

/** Set `false` to leave attachments where they are after a provider switch. */
const MIGRATE_ON_SWITCH_DEFAULT = true;

/**
 * How many attachments a pass reached each outcome, and which ones it could not
 * move.
 *
 * The ids are here because the alternative was a log line per failed attachment
 * on every pass. A row that can never move -- a file missing from the volume a
 * database dump was restored without -- is re-read hourly forever, so per-row
 * warnings are a flood that buries the log they are meant to inform, while a
 * count alone cannot answer the only question an operator has: *which ones*. So
 * the detail per attachment goes to `debug` and the pass names what it could not
 * move, capped at `MAX_REPORTED_FAILURES`. `AttachmentOrphanSweeper` answers the
 * same question from `attachment_blob_tombstones.attempts` / `last_error`; a
 * relocation failure has no row of its own to record, and giving it one is a
 * migration rather than a log line.
 */
export interface RelocationOutcome extends Record<RelocationTally, number> {
  /** Attachments this pass could not move, capped for the summary line. */
  failedIds: string[];
}

/** The four outcomes one attachment can reach, each a counter on the tally. */
export type RelocationTally = "moved" | "skipped" | "failed" | "unreachable";

/**
 * How many failed attachment ids one summary line names.
 *
 * Enough to start an investigation, few enough that the line stays one line: an
 * operator with four hundred unmovable attachments has a configuration problem,
 * not four hundred separate problems.
 */
export const MAX_REPORTED_FAILURES = 10;

/** One batch's tally, plus where the next batch resumes. */
type RelocationBatch = RelocationOutcome & { cursor: string; scanned: number };

/** A tally with nothing in it, which is also what a pass that does nothing returns. */
const emptyOutcome = (): RelocationOutcome => ({
  moved: 0,
  skipped: 0,
  failed: 0,
  unreachable: 0,
  failedIds: [],
});

/**
 * One row's worth of what the relocation needs to know.
 *
 * An index signature because that is what a raw row is, and because
 * `attachmentBytesConsistent` reads `byte_size` and `sha256` off exactly this
 * shape -- the same comparison the export and the restore make, against the same
 * two columns.
 */
interface RelocationRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  storage_provider: string;
  /** The provider-opaque key, which is the row's own id on every provider today. */
  storage_key: string;
  byte_size: string | number;
  sha256: string;
}

/**
 * Moves attachment bytes into the backend `ATTACHMENT_STORAGE_PROVIDER` now
 * names.
 *
 * Changing that setting used to rebind where the *next* attachment is written and
 * nothing else: every row already in `transaction_attachments` kept pointing at
 * the backend it was uploaded to, the download path asked the newly bound
 * provider for it, and the answer was 404 for the user's whole history of
 * receipts. The bytes were never lost -- an operator who switched back saw them
 * all again -- but nothing in the product said so, and nothing moved them.
 *
 * Two changes make the switch a migration instead. Reads resolve a row's provider
 * from the row (`AttachmentStorageRegistry`), so an attachment is readable
 * throughout; and this service copies each row's bytes to the active backend and
 * flips `storage_provider` to match, on boot and hourly until nothing is left.
 * Both directions, any pair of backends, no operator action.
 *
 * What it assumes is stated because it is not free: **both backends must be
 * configured at once**. The source is read through its own provider, so the S3
 * bucket a deployment is leaving has to stay reachable until its objects are
 * gone. A row whose backend cannot be addressed is counted, logged and left
 * exactly as it is -- its bytes are still there, and a later boot with the
 * setting restored migrates it.
 *
 * ## One row at a time, and never half of one
 *
 * Per row, inside one transaction, in this order: lock the row and re-read what
 * it says (a row another replica already moved, or that was deleted meanwhile, is
 * dropped here, before any byte is written); read the bytes the row names; check
 * them against the row's own `byte_size` and `sha256`; write them to the active
 * backend; read them back and check the copy the same way; flip
 * `storage_provider`; record the source object as unreferenced; then commit. The
 * source bytes are deleted only after that commit.
 *
 * Every refusal is therefore before the write, which is what makes an interrupted
 * pass safe to repeat: the worst a crash leaves is bytes in the new backend that
 * nothing references yet, recorded as an intent so the orphan sweeper can find
 * them, and a row still pointing at the copy that is definitely intact.
 *
 * Nothing here is a `TRUNCATE`-and-copy or a bulk `UPDATE`: a relocation that
 * flipped the column for many rows and then copied would, at any interruption,
 * leave metadata naming bytes that are not there yet -- the one failure the
 * attachment lifecycle is built to exclude (INV-ATTACHMENT-001).
 */
@Injectable()
export class AttachmentStorageMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentStorageMigrator.name);
  private readonly enabled: boolean;
  /** One pass at a time in this process; the lease handles other replicas. */
  private running = false;
  /** So a deployment with the relocation switched off says so once, not hourly. */
  private announcedDisabled = false;
  /** The same, for an active backend this deployment cannot write to. */
  private announcedUnaddressable = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: AttachmentStorageRegistry,
    private readonly fetchSync: FetchSyncService,
    private readonly orphanSweeper: AttachmentOrphanSweeper,
    config: ConfigService,
  ) {
    // Compared as the string it is, per the boolean-env rule: only an explicit
    // "false" turns the relocation off, so a typo leaves the safe behaviour.
    const raw = (
      config.get<string>("ATTACHMENT_STORAGE_MIGRATE_ON_SWITCH") ?? ""
    )
      .trim()
      .toLowerCase();
    this.enabled = raw === "" ? MIGRATE_ON_SWITCH_DEFAULT : raw !== "false";
  }

  /**
   * Start the relocation on boot, without making the boot wait for it.
   *
   * Deliberately not awaited: Nest runs bootstrap hooks inside `app.listen()`, so
   * awaiting a copy of every attachment in the deployment would hold the port
   * closed for as long as the backlog takes -- a readiness probe failing on a
   * container that is working perfectly. The first pass runs beside the serving
   * process, and reads keep working throughout because they resolve each row's
   * backend from the row.
   */
  onApplicationBootstrap(): void {
    void this.relocateSafely("startup");
  }

  /**
   * The retry, and the reason a failed pass needs no operator.
   *
   * A provider outage, an expired credential or a full disk stops a pass partway;
   * the rows it did not reach still name their own backend, so nothing is broken
   * and nothing is urgent. This is what tries again. When there is nothing to do
   * it costs one `LIMIT 1` over a table with a row per attachment -- unindexed on
   * `storage_provider`, and cheap at this application's scale rather than free.
   */
  @Cron("0 50 * * * *")
  async relocateOnSchedule(): Promise<void> {
    await this.relocateSafely("hourly");
  }

  /**
   * `relocateAll`, with nothing escaping.
   *
   * Both entry points need it and for different reasons: an unhandled rejection
   * from the bootstrap hook's floating promise terminates the process on Node's
   * default, and a throw out of a cron handler is a scheduler error with no
   * attachment named in it. Neither is a sensible outcome for a copy that can
   * simply be tried again at :50.
   */
  private async relocateSafely(trigger: string): Promise<void> {
    try {
      await this.relocateAll(trigger);
    } catch (error) {
      this.logger.warn(
        `Attachment storage relocation (${trigger}) failed: ${describe(error)}`,
      );
    }
  }

  /**
   * Relocate everything the active backend does not already hold.
   *
   * The drain is a loop of leased batches rather than one long lease: a batch
   * hands the lease back, so a second replica can take the next one instead of
   * waiting out a window sized for the whole backlog. A replica that loses the
   * lease stops -- another is draining, and the hourly pass is what covers a
   * winner that then dies.
   */
  async relocateAll(trigger: string): Promise<RelocationOutcome> {
    const total = emptyOutcome();
    if (this.running) return total;
    this.running = true;
    try {
      if (!(await this.hasPendingRows())) return total;
      if (!this.enabled) {
        this.announceDisabled();
        return total;
      }
      if (!this.registry.active.addressable) {
        // Nothing can be written to a backend this deployment cannot address, so
        // walking the table to fail on every row would only cost a warning and
        // two tombstone writes per attachment per hour.
        this.announceUnaddressableDestination();
        return total;
      }
      this.logger.log(
        `Attachment storage relocation (${trigger}): moving attachment bytes into ` +
          `the "${this.registry.active.name}" backend`,
      );
      let cursor = "";
      for (;;) {
        // A holder rather than a plain `let`, because what the leased callback
        // assigns is read after it returns and the compiler cannot see that the
        // lease ran it.
        const batch: { value: RelocationBatch | null } = { value: null };
        // The lease itself is database access, and `fetch_sync` belongs to no
        // user, so the claim and its release need the ambient system identity
        // the same way every other `withLease` call site seeds one. Wrapping
        // only the batch -- as this did -- left `claim()` outside any context,
        // and `withScopedDb` refused it before a single row was read.
        const held = await withSystemContext(() =>
          this.fetchSync.withLease(
            FetchSyncJob.AttachmentRelocation,
            RELOCATION_LEASE_MS,
            async () => {
              batch.value = await this.relocateBatch(cursor);
            },
          ),
        ).catch((error: unknown) => {
          this.logger.warn(
            `Attachment storage relocation batch failed: ${describe(error)}`,
          );
          return false;
        });
        const done = batch.value;
        // Nothing to add when this replica lost the lease (another is draining) or
        // the batch threw: the rows it did not move still name their own backend.
        if (!held || !done) break;
        total.moved += done.moved;
        total.skipped += done.skipped;
        total.failed += done.failed;
        total.unreachable += done.unreachable;
        total.failedIds.push(
          ...done.failedIds.slice(
            0,
            Math.max(0, MAX_REPORTED_FAILURES - total.failedIds.length),
          ),
        );
        if (done.scanned < RELOCATION_BATCH) break;
        cursor = done.cursor;
      }
      this.report(total);
      return total;
    } finally {
      this.running = false;
    }
  }

  /**
   * Say once that attachments are somewhere the active backend is not, and that
   * this deployment has been told not to move them.
   *
   * An operator who switched off the relocation still gets a readable product --
   * reads resolve each row's own backend -- so the only thing they are owed is the
   * fact, in the log, rather than a surprise the first time they decommission the
   * old store.
   */
  private announceDisabled(): void {
    if (this.announcedDisabled) return;
    this.announcedDisabled = true;
    this.logger.warn(
      `Some attachments are stored outside the active "${this.registry.active.name}" ` +
        `backend and ATTACHMENT_STORAGE_MIGRATE_ON_SWITCH=false, so they will not be ` +
        `moved. They stay readable from the backend each one names; keep it ` +
        `configured, or unset the variable to relocate them.`,
    );
  }

  /**
   * Say once that the backend new bytes are meant to go to cannot be reached.
   *
   * The boot does not refuse this configuration -- `S3StorageProvider` throws on
   * first use, not at construction -- so a deployment naming `s3` with no bucket
   * serves and uploads-fails happily. Attachments stay readable from wherever
   * they are; what cannot happen is a copy into nowhere.
   */
  private announceUnaddressableDestination(): void {
    if (this.announcedUnaddressable) return;
    this.announcedUnaddressable = true;
    this.logger.warn(
      `Some attachments are stored outside the active "${this.registry.active.name}" ` +
        `backend, and that backend is not configured (an s3 provider needs ` +
        `ATTACHMENT_S3_BUCKET). They stay readable from the backend each one names; ` +
        `nothing is moved until the active backend can be written to.`,
    );
  }

  /** Whether any attachment's bytes are somewhere other than the active backend. */
  private async hasPendingRows(): Promise<boolean> {
    const rows = await withSystemContext(() =>
      withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT 1 FROM transaction_attachments
            WHERE storage_provider <> $1 LIMIT 1`,
          [this.registry.active.name],
        ),
      ),
    );
    return returnedRows<Record<string, unknown>>(rows).length > 0;
  }

  /**
   * One batch, keyed forward by id.
   *
   * A keyset cursor rather than an offset or a re-query of the same predicate: a
   * row this pass could not move still matches the predicate, so re-reading it
   * would make the batch that failed the batch that repeats forever while rows
   * behind it wait. Ordering by `id` also means a row another replica moves
   * concurrently drops out of the scan by itself.
   */
  private async relocateBatch(cursor: string): Promise<RelocationBatch> {
    const rows = await withSystemContext(() =>
      withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT id, user_id, storage_provider, storage_key, byte_size, sha256
             FROM transaction_attachments
            WHERE storage_provider <> $1
              AND ($2 = '' OR id > $2::uuid)
            ORDER BY id
            LIMIT $3`,
          // Bound, not interpolated: the value is a constant here, and the one
          // other raw query in this repository that takes a limit binds it too
          // (`built-in-reports/data-quality-reports.service.ts`). A parameter
          // cannot become an injection when somebody makes it configurable.
          [this.registry.active.name, cursor, RELOCATION_BATCH],
        ),
      ),
    );
    const batch = returnedRows<RelocationRow>(rows);
    const outcome: RelocationBatch = {
      ...emptyOutcome(),
      cursor,
      scanned: batch.length,
    };
    for (const row of batch) {
      outcome.cursor = row.id;
      // Each attachment under its owner's identity, so every statement is one
      // their own RLS policies admit; the scan above is the only cross-user read.
      const result = await withUserContext(row.user_id, () =>
        this.relocateRow(row),
      );
      outcome[result] += 1;
      if (
        result === "failed" &&
        outcome.failedIds.length < MAX_REPORTED_FAILURES
      ) {
        outcome.failedIds.push(row.id);
      }
    }
    return outcome;
  }

  /**
   * Move one attachment's bytes, or leave it exactly as it is.
   *
   * The destination intent is committed before the copy and cleared inside the
   * flip, so a crash in between leaves bytes the orphan sweeper can enumerate
   * rather than bytes nobody knows about (audit FV4-003, the same protocol
   * `AttachmentsService.create` uses). The clear is fenced on the sweeper's claim,
   * so the one outcome that cannot happen is a committed row naming bytes that were
   * swept (audit RV4-002).
   */
  private async relocateRow(row: RelocationRow): Promise<RelocationTally> {
    const destination = this.registry.active;
    const source = this.registry.resolve(row.storage_provider);
    if (!source) return "unreachable";

    const key = row.storage_key;
    await recordObjectIntent(
      this.dataSource,
      destination.name,
      key,
      row.user_id,
      RELOCATION_LEASE_MS,
    );
    let wroteObject = false;
    let outcome: RelocationTally;
    try {
      outcome = await withScopedDb(this.dataSource, async (m) => {
        const locked = await this.lockRow(m, row.id, source.name);
        if (!locked) return "skipped";

        const bytes = await source.load(key);
        if (!attachmentBytesConsistent(bytes, locked)) {
          // The source disagrees with its own metadata, so copying it would
          // publish a checksum the new backend cannot satisfy either. Left where
          // it is; the repair is a restore, not this pass. At `debug` because the
          // pass summary names the attachment and this line repeats hourly.
          this.logger.debug(
            `Attachment ${row.id} was not relocated: the bytes in "${source.name}" ` +
              `do not match the size and checksum recorded for them`,
          );
          return "failed";
        }

        await destination.save(key, bytes);
        wroteObject = destination.name !== "database";
        await this.verifyCopy(destination, key, locked);

        await m.query(
          `UPDATE transaction_attachments
              SET storage_provider = $1
            WHERE id = $2 AND storage_provider = $3`,
          [destination.name, row.id, source.name],
        );
        await this.retireSource(m, source, row);
        // Commits with the row that now owns these bytes, and refuses if the
        // sweeper claimed them first -- in which case this whole transaction rolls
        // back and the attachment keeps pointing at the source copy.
        await clearObjectIntent(m, destination.name, key);
        return "moved";
      });
    } catch (error) {
      // At `debug` for the same reason: a row that can never move fails on every
      // pass, and `report` is what says so once, with the ids.
      this.logger.debug(
        `Attachment ${row.id} could not be moved from "${row.storage_provider}" to ` +
          `"${destination.name}": ${describe(error)}`,
      );
      outcome = "failed";
    }

    if (outcome === "moved") {
      // Committed, so the source object is referenced by nothing. Its tombstone
      // is what guarantees the delete; this is only promptness.
      if (source.name !== "database") {
        await this.orphanSweeper.sweepKey(key, source.name);
      }
      return outcome;
    }

    // Not moved: the row still points at the source, so anything written to the
    // destination is unreferenced and the intent must not be left behind either.
    if (wroteObject) {
      await destination
        .delete(key)
        .catch((error: unknown) =>
          this.logger.warn(
            `A copy of attachment ${row.id} was left in "${destination.name}" and ` +
              `could not be removed; the orphan sweep will take it: ` +
              `${describe(error)}`,
          ),
        );
    }
    await dropCommittedObjectIntent(
      this.dataSource,
      destination.name,
      key,
      (message) =>
        this.logger.warn(
          `Could not clear the relocation intent for attachment ${row.id}; the ` +
            `orphan sweep will retry a no-op delete: ${message}`,
        ),
    );
    return outcome;
  }

  /**
   * Take the row under lock and confirm it still says what the scan said.
   *
   * The lock is what makes every check here final: two replicas cannot both pass
   * it, and a concurrent delete or edit either waits for this transaction or is
   * already reflected in what it reads. `null` covers a row that is gone and a row
   * another pass already moved, which are the same instruction -- write nothing.
   *
   * It is also the re-read the refusal rule asks for: the scan that chose this row
   * ran in another transaction, so its answer is a candidate and this one is the
   * fact the write is allowed to rely on.
   */
  private async lockRow(
    m: EntityManager,
    id: string,
    sourceProvider: string,
  ): Promise<RelocationRow | null> {
    const rows = await m.query(
      `SELECT id, user_id, storage_provider, storage_key, byte_size, sha256
         FROM transaction_attachments
        WHERE id = $1 AND storage_provider = $2
        FOR UPDATE`,
      [id, sourceProvider],
    );
    return returnedRows<RelocationRow>(rows)[0] ?? null;
  }

  /**
   * Read the copy back and hold it to the same row it was copied for.
   *
   * The claim being made is "this attachment's bytes are in the new backend", and
   * the source is about to be deleted on the strength of it. A `save` that
   * resolved is not that claim: `PutObject` returning 200 through a proxy, a
   * filesystem that took the write into a cache, a bucket with a lifecycle rule
   * -- each ends with a row naming an object that is absent or wrong. One extra
   * read per attachment, once ever, is what turns the claim into a check.
   *
   * Skipped for the `database` destination alone, where the copy is a row in the
   * same transaction and re-reading it would only ask Postgres whether it means
   * what it just said.
   */
  private async verifyCopy(
    destination: AttachmentStorageProvider,
    key: string,
    row: RelocationRow,
  ): Promise<void> {
    if (destination.name === "database") return;
    const written = await destination.load(key);
    if (!attachmentBytesConsistent(written, row)) {
      throw new Error(
        `the copy written to "${destination.name}" does not match the size and ` +
          `checksum recorded for the attachment`,
      );
    }
  }

  /**
   * Make the source copy's bytes collectable, inside the flip's transaction.
   *
   * For the `database` source that is the whole job: the blob is a row, so
   * deleting it here commits with the flip and rolls back with it. For a
   * filesystem or a bucket it is a tombstone -- the same record the delete path
   * writes -- because the object itself cannot be removed transactionally, and
   * doing it before the commit is the one order that can leave a row pointing at
   * bytes that are gone. The sweep after the commit is promptness; the tombstone
   * is the guarantee.
   */
  private async retireSource(
    m: EntityManager,
    source: AttachmentStorageProvider,
    row: RelocationRow,
  ): Promise<void> {
    if (source.name === "database") {
      await source.delete(row.storage_key);
      return;
    }
    await m.query(
      `INSERT INTO attachment_blob_tombstones
         (user_id, storage_provider, storage_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (storage_provider, storage_key) DO NOTHING`,
      [row.user_id, source.name, row.storage_key],
    );
  }

  /** One line per pass, and silence when a pass had nothing to say. */
  private report(outcome: RelocationOutcome): void {
    const { moved, skipped, failed, unreachable, failedIds } = outcome;
    if (moved + failed + unreachable === 0) return;
    const parts = [`${moved} attachment(s) moved`];
    if (skipped > 0) parts.push(`${skipped} already moved elsewhere`);
    if (failed > 0) {
      // The ids, because "40 left in place" cannot be investigated and
      // "40 left in place: <id>, <id>, ..." can. The reason per attachment is one
      // log level down, so a deployment that wants it can have it without every
      // deployment carrying it hourly.
      const named = failedIds.join(", ");
      parts.push(
        `${failed} left in place after an error` +
          (named.length > 0
            ? ` (${named}${failed > failedIds.length ? ", ..." : ""}; raise the log level to debug for the reason per attachment)`
            : ""),
      );
    }
    if (unreachable > 0) {
      parts.push(
        `${unreachable} in a backend this deployment cannot address (configure it ` +
          `and they will be moved on the next pass)`,
      );
    }
    const line = `Attachment storage relocation: ${parts.join(", ")}`;
    if (failed > 0 || unreachable > 0) this.logger.warn(line);
    else this.logger.log(line);
  }
}

/** The message of a thrown value, whatever it is. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
