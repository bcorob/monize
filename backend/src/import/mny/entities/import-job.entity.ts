import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../../../users/entities/user.entity";
import { ImportStagedFile } from "./import-staged-file.entity";
import {
  ImportJobStatus,
  MnyImportProgress,
  MnyImportResult,
} from "../model/mny-import-job";
import { MnyImportOptions } from "../model/mny-import-options";

/**
 * The partial unique index enforcing one `pending`/`running` job per user.
 *
 * Named here so the constraint the database reports on a losing INSERT and the
 * constraint the service translates into a 409 are provably the same string.
 */
export const ONE_ACTIVE_JOB_INDEX = "idx_import_jobs_one_active_per_user";

/**
 * The partial unique index holding one committed import per user and file
 * content (audit A26-H08). Named for the same reason as the index above: the
 * commit checkpoint translates exactly this constraint's 23505.
 */
export const COMMITTED_CONTENT_INDEX = "idx_import_jobs_committed_content";

/**
 * One background import attempt (design ADR-3).
 *
 * The row is the coordination point: `POST /import/mny/start` inserts it
 * `pending`, exactly one worker claims it by moving it to `running`, the running
 * job writes `progress` and `heartbeat_at` in their own short transactions so a
 * poller can see them, and a job whose heartbeat went stale is failed by the
 * next request that reads or competes for the slot -- with an hourly cron as the
 * backstop for a user who never asks again.
 * A failed job keeps `stagedFileId`, so Retry is a new job over the same bytes.
 *
 * The partial unique index is what makes "one import at a time per user" true:
 * two concurrent starts would otherwise both count zero active jobs and both
 * insert, importing the same staged bytes twice. Declared here as well as in
 * migration 135 because test and dev databases are synchronized from the
 * entities -- a guard that exists only in SQL cannot be tested.
 */
@Index(ONE_ACTIVE_JOB_INDEX, ["userId"], {
  unique: true,
  where: "status IN ('pending', 'running')",
})
@Index(COMMITTED_CONTENT_INDEX, ["userId", "contentSha256"], {
  unique: true,
  where: "content_sha256 IS NOT NULL",
})
@Entity("import_jobs")
export class ImportJob {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "staged_file_id", nullable: true })
  stagedFileId: string | null;

  // SET NULL, not CASCADE: a completed job's verification report has to outlive
  // the bytes it was produced from, so the TTL sweep must not take import
  // history with it. Declared here as well as in the migration because test and
  // dev databases are synchronized from the entities.
  @ManyToOne(() => ImportStagedFile, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "staged_file_id" })
  stagedFile?: ImportStagedFile | null;

  @Column({
    type: "varchar",
    name: "source_format",
    length: 20,
    default: "mny",
  })
  sourceFormat: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: ImportJobStatus;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  options: MnyImportOptions;

  @Column({ type: "jsonb", nullable: true })
  progress: MnyImportProgress | null;

  @Column({ type: "jsonb", nullable: true })
  result: MnyImportResult | null;

  /** i18n key for a failed job. Never a raw message, never a stack. */
  @Column({ type: "varchar", name: "error_key", length: 100, nullable: true })
  errorKey: string | null;

  /** Untranslated diagnostic detail for the log and the failure report. */
  @Column({ type: "text", name: "error_detail", nullable: true })
  errorDetail: string | null;

  /** True when Retry over the same staged file is worth offering. */
  @Column({ name: "retryable", default: false })
  retryable: boolean;

  /**
   * True once this job's rows committed to the ledger.
   *
   * Set in the import's own write transaction, so it is never true for a commit
   * that rolled back. It is what makes `retryable` honest after a stall: before
   * the commit a retry costs nothing, after it a retry imports the file twice --
   * the mapper assigns fresh UUIDs on every parse and nothing on an inserted row
   * identifies the source record, so nothing deduplicates the second run.
   */
  @Column({ name: "data_committed", default: false })
  dataCommitted: boolean;

  /**
   * The current attempt's identity, minted by `claim()` (migration 144).
   *
   * Every write the worker makes requires it, and the reaper clears it when it
   * takes the job away -- which is what stops a worker that has already lost the
   * job from committing anyway. `retryable` cannot express this: it describes what
   * happened, and the question is whether the write may happen at all
   * (audit RV4-001).
   */
  @Column({ type: "uuid", name: "attempt_token", nullable: true })
  attemptToken: string | null;

  /**
   * The digest of the bytes this job committed (migration 20261022061534).
   *
   * Written by the commit checkpoint inside the import transaction, so it is
   * set exactly when the rows are; held by `COMMITTED_CONTENT_INDEX`, so the
   * same file cannot be committed into this user's ledger a second time.
   * Cleared when a "start fresh" import's wipe removed the rows it vouched for.
   */
  @Column({ type: "char", length: 64, name: "content_sha256", nullable: true })
  contentSha256: string | null;

  /** Bumped by the running job; the reaper's liveness signal. */
  @Column({ type: "timestamp", name: "heartbeat_at", nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: "timestamp", name: "started_at", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamp", name: "completed_at", nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
