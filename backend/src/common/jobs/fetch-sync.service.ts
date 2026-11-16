import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import { withScopedDb } from "../db/scoped-db";
import { returnedRows } from "../db/query-result";

/**
 * Every deployment-wide job one replica should run per tick, and which of them
 * this deployment's jobs may name.
 *
 * Spelled out so a typo is a compile error rather than a second lease nobody
 * contends for -- which would look exactly like the job working.
 *
 * The first three are the outbound market-data fetches this table was added for.
 * The fourth is the attachment relocation pass, which is not a fetch but has the
 * same shape for the same reason: its writes converge whoever runs them (per-row,
 * under a lock, idempotent by key), so what a second replica duplicates is the
 * cost -- reads and writes of bytes that end up identical -- and not the result.
 */
export const FetchSyncJob = {
  ExchangeRates: "exchange-rates",
  SecurityPrices: "security-prices",
  MarketIndexes: "market-indexes",
  AttachmentRelocation: "attachment-relocation",
  BondBenchmarks: "bond-benchmarks",
  BondPrices: "bond-prices",
  BondSeries: "bond-series",
} as const;

/**
 * The lease of one bond program's refresh (`BondSeriesService.fetchProgramOffer`),
 * one row per program: a person's Refresh, not a cron, so the job is the
 * program, and the key is built here so a typo stays a compile error.
 */
export function bondProgramRefreshJob(
  programKey: string,
): `bond-program-refresh:${string}` {
  return `bond-program-refresh:${programKey}`;
}

/**
 * The lease of one attempt to fetch one bond series in a bounded history pass,
 * one row per series: held for a day, it is the negative cache every replica
 * reads, so a series the source refused is not asked for again by the next
 * Refresh.
 */
export function bondSeriesAttemptJob(
  countryCode: string,
  seriesCode: string,
): `bond-series-attempt:${string}` {
  return `bond-series-attempt:${countryCode.toUpperCase()}|${seriesCode.toUpperCase()}`;
}

/** What a long job reports in `fetch_sync.progress`. */
export interface FetchProgress {
  /** ISO timestamp the run began. */
  readonly startedAt: string;
  readonly phase: "offer" | "series" | "done";
  readonly done: number;
  readonly total: number;
  readonly seriesCode: string | null;
  /** ISO timestamp the run ended; null while it runs. */
  readonly finishedAt: string | null;
}

export type FetchSyncJob =
  | (typeof FetchSyncJob)[keyof typeof FetchSyncJob]
  | ReturnType<typeof bondProgramRefreshJob>
  | ReturnType<typeof bondSeriesAttemptJob>;

/**
 * One replica per tick does the work.
 *
 * Every replica fires the FX, security-price and market-index crons. Their
 * writes are idempotent upserts, so the *data* converges however many run --
 * what does not converge is the cost: N replicas is N times the provider calls,
 * N times the rate-limit budget, and N chances to trip the breaker on a
 * provider that is merely slow. The attachment relocation pass joins them on the
 * same terms, with object-store traffic in place of provider calls.
 *
 * So this is a **cost control, not a correctness mechanism**, and that decides
 * its shape at every point:
 *
 * - A lease, never a permanent claim. A holder that crashes must not block the
 *   next tick, so the lease is shorter than the cron's interval and a lost one
 *   is reclaimed by the expiry alone, with nobody to notice.
 * - A lost claim is a debug line and a return, never an error. Losing is the
 *   normal outcome for every replica but one.
 * - `release` and `markSuccess` address the row **by token**, the way
 *   `JobClaimService` does: a worker delayed past its own expiry must not hand
 *   back a lease another replica has since retaken.
 *
 * Not `JobClaimService`: `job_claims.user_id` is a `NOT NULL` foreign key to
 * `users`, and these fetches belong to no user -- one USD/EUR rate serves
 * everybody. Not `market_index_sync` either, which keeps its own per-index
 * attempt cooldown: that decides how often ONE index is worth re-asking for,
 * this decides which replica asks at all.
 *
 * Every call needs an ambient identity, like any other database access -- the
 * claim and the release included, so the caller's `withSystemContext` goes around
 * the whole `withLease` call and not around only the body it runs.
 */
@Injectable()
export class FetchSyncService {
  private readonly logger = new Logger(FetchSyncService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Take the lease for `job`, or `null` for a caller that lost.
   *
   * One statement. The `DO UPDATE ... WHERE` arm is the lease: an existing row
   * is retaken only when its own `lease_until` has passed, so a live lease
   * returns no row and its loser stands down. `RETURNING lease_token` is what
   * makes the win a thing the caller can hold, and the `INSERT` is the
   * serialization point -- there is no window between deciding and recording.
   */
  async claim(job: FetchSyncJob, leaseMs: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO fetch_sync (job, lease_until, lease_token)
         VALUES ($1, CURRENT_TIMESTAMP + ($2::bigint::text || ' milliseconds')::interval, $3::uuid)
         ON CONFLICT (job) DO UPDATE
            SET lease_until = EXCLUDED.lease_until,
                lease_token = EXCLUDED.lease_token
          WHERE fetch_sync.lease_until IS NULL
             OR fetch_sync.lease_until < CURRENT_TIMESTAMP
         RETURNING lease_token`,
        [job, Math.round(leaseMs), token],
      ),
    );
    const [row] = returnedRows<{ lease_token: string }>(rows);
    return row ? row.lease_token : null;
  }

  /**
   * Hand the lease back early, so a shorter-than-expected run does not hold the
   * job until its expiry.
   *
   * A no-op unless this caller still holds it: the token is in the predicate,
   * so a run that outlived its lease cannot free the one a replica now fetching
   * took.
   */
  async release(job: FetchSyncJob, leaseToken: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE fetch_sync
            SET lease_until = NULL, lease_token = NULL
          WHERE job = $1 AND lease_token = $2::uuid`,
        [job, leaseToken],
      ),
    );
  }

  /**
   * Record that this holder's fetch finished, and release the lease.
   *
   * `last_success_at` and `last_error` are bookkeeping for an operator reading
   * the table; nothing branches on them. The lease is what matters, and it is
   * released here too so the row does not sit held for the rest of its window
   * after the work is done.
   */
  async markSuccess(job: FetchSyncJob, leaseToken: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE fetch_sync
            SET last_success_at = CURRENT_TIMESTAMP,
                last_error = NULL,
                lease_until = NULL,
                lease_token = NULL
          WHERE job = $1 AND lease_token = $2::uuid`,
        [job, leaseToken],
      ),
    );
  }

  /** Record why this holder's fetch failed, and release the lease. */
  async markFailure(
    job: FetchSyncJob,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE fetch_sync
            SET last_error = $3,
                lease_until = NULL,
                lease_token = NULL
          WHERE job = $1 AND lease_token = $2::uuid`,
        [job, leaseToken, error.slice(0, 2000)],
      ),
    );
  }

  /**
   * What the holder of `job`'s lease reports while it works (`fetch_sync.progress`),
   * for a person polling a long run.
   *
   * Conditional on the token, like `release`: a holder that lost its lease
   * writes nothing. One statement outside any other transaction, and the lease
   * is untouched.
   */
  async reportProgress(
    job: FetchSyncJob,
    leaseToken: string,
    progress: FetchProgress,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE fetch_sync
            SET progress = $3::jsonb
          WHERE job = $1 AND lease_token = $2::uuid`,
        [job, leaseToken, JSON.stringify(progress)],
      ),
    );
  }

  /** The progress last reported for `job`, or `null` when none was. */
  async readProgress(job: FetchSyncJob): Promise<FetchProgress | null> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(`SELECT progress FROM fetch_sync WHERE job = $1`, [job]),
    );
    const [row] = returnedRows<{ progress: FetchProgress | null }>(rows);
    return row?.progress ?? null;
  }

  /**
   * Run `fn` if this replica takes the lease; otherwise log at debug and
   * return `false`.
   *
   * The whole point of putting it here rather than at each call site: the
   * lease has to be given back on **both** paths, and every caller that takes
   * one would otherwise spell out the same `try/finally` -- which is the kind of
   * thing that is right in all but one of the places.
   */
  async withLease(
    job: FetchSyncJob,
    leaseMs: number,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const token = await this.claim(job, leaseMs);
    if (!token) {
      this.logger.debug(
        `Fetch job "${job}" is held by another replica; skipping`,
      );
      return false;
    }
    try {
      await fn();
      await this.markSuccess(job, token);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Recorded and released, then rethrown: the caller's own catch is what
      // decides how a failed fetch is reported, and swallowing it here would
      // take that decision away from three different crons at once.
      await this.markFailure(job, token, message);
      throw error;
    }
  }
}
