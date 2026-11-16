import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../db/scoped-db";
import { acquireAdvisoryLock, LockScope } from "../db/locks";
import { returnedRows } from "../db/query-result";
import { JobClaimService, JobClaimType } from "./job-claim.service";
import { tr } from "../../i18n/translate";

/**
 * Exclusion between the operations that replace a user's whole dataset and
 * anything that would read or derive from it while they run (audit DR-04-02).
 *
 * Three operations rewrite everything a user owns: a backup restore, the
 * self-service "delete my data", and a `.mny` import started with
 * `wipeExistingData`. Each is internally consistent -- restore and delete are
 * one transaction apiece, so a concurrent reader sees the before or the after and
 * never a half -- but they are not consistent with *each other*, and the `.mny`
 * import is not one transaction at all: its wipe commits and the rows then
 * arrive over the following minutes, so for the length of the import the user's
 * dataset is legitimately empty.
 *
 * That window is where the damage is. The hourly auto-backup fired into it would
 * export the empty dataset, write it as today's file, and then enforce retention
 * -- rotating the last good backup out to make room for a file containing
 * nothing. Nothing in the system flags that, and it is not recoverable.
 *
 * So: a lease the destructive operations hold, and an `isUnderMaintenance` read
 * everything derived consults. An active `import_jobs` row counts as
 * maintenance without a lease of its own -- the row already *is* the fact, and
 * inventing a second parallel truth for it is how the two drift.
 */

/** One maintenance operation per user, so the key names the fact, not the window. */
export const USER_MAINTENANCE_CLAIM_KEY = "maintenance";

/**
 * How long a maintenance lease survives without its holder.
 *
 * The happy path releases explicitly, so this only matters after a crash: a
 * process killed mid-restore (a pod eviction, an OOM kill, a dev-server reload)
 * leaves the lease behind and locks the user out of restore and delete-my-data
 * until it expires. Fifteen minutes keeps that lockout short while staying well
 * above a large restore's runtime. A holder that does outlive it is still safe:
 * restore and delete-my-data are each one transaction, so the derived readers
 * that consult `isUnderMaintenance` see the before or the after, and the
 * token-scoped release cannot remove a lease a later operation took.
 */
export const USER_MAINTENANCE_LEASE_MS = 15 * 60 * 1000;

@Injectable()
export class UserMaintenanceService {
  private readonly logger = new Logger(UserMaintenanceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobClaims: JobClaimService,
  ) {}

  /**
   * True while this user's dataset is being replaced.
   *
   * A hint, not a guarantee: a caller that must not *overlap* takes the lease
   * instead. This is for work that is merely pointless or harmful during the
   * window and can simply happen later -- a scheduled backup, a derived
   * recomputation -- where skipping is the whole remedy.
   */
  async isUnderMaintenance(userId: string): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ present: boolean }>(
        await manager.query(
          `SELECT EXISTS (
             SELECT 1 FROM import_jobs
              WHERE user_id = $1 AND status IN ('pending', 'running')
           ) OR EXISTS (
             SELECT 1 FROM job_claims
              WHERE claim_type = $2 AND user_id = $1 AND claim_key = $3
                AND expires_at IS NOT NULL
                AND expires_at > CURRENT_TIMESTAMP
           ) AS present`,
          [userId, JobClaimType.UserMaintenance, USER_MAINTENANCE_CLAIM_KEY],
        ),
      );
      return rows[0]?.present === true;
    });
  }

  /**
   * Run `fn` holding this user's maintenance lease, refusing to start if
   * anything else is already replacing their data.
   *
   * The refusal is a `409`, which is the honest answer: the request was
   * well-formed and is being declined because of the account's current state,
   * and retrying once the other operation finishes will work. It happens before
   * `fn` does anything, so a refused maintenance operation has written nothing --
   * the rule in `AGENTS.md`.
   */
  async withMaintenanceLease<T>(
    userId: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Acquisition is ONE transaction holding ONE lock, and both halves of the
    // decision are inside it.
    //
    // An import in flight is maintenance too, but it records that fact in
    // `import_jobs` while this records it in `job_claims` -- two tables with no
    // shared key, so "check the first, then write the second" is a check-then-act
    // across a gap an import can start in:
    //
    //   1. maintenance reads import_jobs and sees nothing;
    //   2. an import inserts its pending row;
    //   3. maintenance takes its lease;
    //   4. both sides now believe they own the user's dataset.
    //
    // `LockScope.UserImport` is what closes it. `MnyImportJobService.create`
    // takes the same advisory lock on the same user before it inserts, so the
    // two protocols contend on one object: whichever transaction gets the lock
    // completes its check and its write before the other can read. The lock is
    // transaction-scoped, so it is released at commit -- what excludes for the
    // *duration* is the lease this takes (and, for the import, its job row).
    const leased = await withScopedDb(this.dataSource, async (manager) => {
      await acquireAdvisoryLock(manager, LockScope.UserImport, userId);
      if (await this.hasActiveImport(userId)) {
        throw this.busy();
      }
      // Joins this transaction, so the claim lands under the same lock.
      const token = await this.jobClaims.claimLease(
        JobClaimType.UserMaintenance,
        userId,
        USER_MAINTENANCE_CLAIM_KEY,
        USER_MAINTENANCE_LEASE_MS,
      );
      if (!token) {
        // Read under the same lock, so the time reported is the lease that
        // refused this request.
        throw this.busy(await this.minutesUntilLeaseExpires(userId));
      }
      return token;
    });

    this.logger.log(`Maintenance lease taken for user ${userId}: ${operation}`);
    try {
      return await fn();
    } finally {
      await this.jobClaims
        .releaseLease(
          JobClaimType.UserMaintenance,
          userId,
          USER_MAINTENANCE_CLAIM_KEY,
          // By token, so a restore that outran its own lease does not release the
          // one the operation now running holds (DR-RRV4-01).
          leased,
        )
        .catch((error) =>
          // The lease expires on its own, so a failed release costs a delay, not
          // a permanent lockout -- but it must not turn a completed restore into
          // a failed request.
          this.logger.warn(
            `Failed to release the maintenance lease for user ${userId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }
  }

  /** True while an import job for this user is pending or running. */
  private async hasActiveImport(userId: string): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ present: boolean }>(
        await manager.query(
          `SELECT EXISTS (
             SELECT 1 FROM import_jobs
              WHERE user_id = $1 AND status IN ('pending', 'running')
           ) AS present`,
          [userId],
        ),
      );
      return rows[0]?.present === true;
    });
  }

  /**
   * Whole minutes, rounded up, until this user's maintenance lease expires, or
   * null when there is no live lease to report.
   *
   * The lease is the upper bound on the wait: the operation holding it either
   * finishes and releases it sooner, or died and leaves it to expire. Telling
   * the user so is what turns a lease stranded by a crash from an indefinite
   * "try again later" into a known wait.
   */
  private async minutesUntilLeaseExpires(
    userId: string,
  ): Promise<number | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ minutes: number | string | null }>(
        await manager.query(
          `SELECT CEIL(EXTRACT(EPOCH FROM (expires_at - CURRENT_TIMESTAMP)) / 60)
                    AS minutes
             FROM job_claims
            WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3
              AND expires_at IS NOT NULL
              AND expires_at > CURRENT_TIMESTAMP`,
          [JobClaimType.UserMaintenance, userId, USER_MAINTENANCE_CLAIM_KEY],
        ),
      );
      const minutes = rows[0]?.minutes;
      return minutes === null || minutes === undefined
        ? null
        : Math.max(1, Number(minutes));
    });
  }

  private busy(minutesUntilExpiry: number | null = null): ConflictException {
    if (minutesUntilExpiry !== null) {
      return new ConflictException(
        tr(
          "errors.maintenance.inProgressRetryAfter",
          `Another operation is currently replacing this account's data. It will finish or time out within ${minutesUntilExpiry} min; try again then.`,
          { minutes: minutesUntilExpiry },
        ),
      );
    }
    return new ConflictException(
      tr(
        "errors.maintenance.inProgress",
        "Another operation is currently replacing this account's data. Wait for it to finish and try again.",
      ),
    );
  }
}
