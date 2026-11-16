import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * One row per outbound market-data fetch job, holding the lease that decides
 * which replica calls the provider this tick.
 *
 * The three fetches (exchange rates, security prices, market indexes) fire on
 * every replica and write idempotent upserts, so the *data* converges however
 * many run. What does not is the cost: N replicas is N times the provider
 * calls, N times the rate-limit budget, and N chances to trip the circuit
 * breaker on a provider that is merely slow.
 *
 * So this is a cost control. A crashed holder must never block the next tick,
 * which is why the lease expires rather than being released by a person, and
 * why `lease_until` is always shorter than the cron's interval.
 *
 * Deployment-wide state with no owner column, so RLS-exempt for the same reason
 * `market_index_sync` is (`backend/src/common/db/rls-exempt-tables.ts`,
 * `docs/row-level-security-contract.md`).
 */
@Entity("fetch_sync")
export class FetchSync {
  /** The job's name, from the `FetchSyncJob` const. One row per job, forever. */
  @PrimaryColumn({ type: "text" })
  job: string;

  /**
   * When the current holder's lease ends, or `null` when nobody holds it.
   *
   * Compared against the database's own clock and never a process's: two
   * replicas whose clocks differ must not disagree about whether a lease is
   * live.
   */
  @Column({ type: "timestamptz", name: "lease_until", nullable: true })
  leaseUntil: Date | null;

  /**
   * Which attempt holds the lease. The key above names the *work*; this names
   * the *holder*, so a worker delayed past its own expiry cannot release or
   * write against a lease another replica has since retaken.
   */
  @Column({ type: "uuid", name: "lease_token", nullable: true })
  leaseToken: string | null;

  /** Bookkeeping for an operator reading the table. Nothing branches on it. */
  @Column({ type: "timestamptz", name: "last_success_at", nullable: true })
  lastSuccessAt: Date | null;

  /** Why the last attempt failed, bounded. Bookkeeping, like the column above. */
  @Column({ type: "text", name: "last_error", nullable: true })
  lastError: string | null;

  /**
   * What the holder reports while it works (`FetchSyncService.reportProgress`),
   * camelCase JSON, for a person polling a long run. Null for a job that
   * reports nothing.
   */
  @Column({ type: "jsonb", name: "progress", nullable: true })
  progress: Record<string, unknown> | null;
}
