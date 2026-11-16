import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * One HTTP rate-limit counter, keyed by throttler and by the guard's own key.
 *
 * Only `CLUSTER_MODE=multi` writes here. In `single` the library's in-process
 * `Map` is correct, because there is only one process; at two replicas it means
 * every `@Throttle` cap is enforced twice over.
 *
 * The table is `UNLOGGED` (see the migration and `database/schema.sql`), which
 * TypeORM cannot express and does not need to: nothing in the application
 * behaves differently, and the integration harness building a logged copy from
 * this metadata still exercises every property the storage claims. What
 * `UNLOGGED` changes is who keeps the rows after a crash, and the answer is
 * nobody -- deliberately.
 *
 * There is no `user_id`. `ThrottlerGuard` runs before
 * `RequestContextInterceptor`, so no identity exists when the row is written,
 * and `key` is already `sha256(class-handler-throttler-tracker)`. RLS-exempt
 * with that reason (`backend/src/common/db/rls-exempt-tables.ts`,
 * `docs/row-level-security-contract.md`).
 */
@Entity("http_throttle_counters")
export class HttpThrottleCounter {
  /** The throttler: `default`, or a `@Throttle` override's name. */
  @PrimaryColumn({ type: "text" })
  name: string;

  /** `ThrottlerGuard.generateKey`'s hash. Opaque by construction. */
  @PrimaryColumn({ type: "text" })
  key: string;

  /** Requests counted inside the current window. */
  @Column({ type: "int" })
  hits: number;

  /**
   * When the current window ends.
   *
   * A row past this is not a zero waiting to be deleted: the next hit resets it
   * in place, which is what makes the daily sweep a collection of garbage and
   * never a part of the limit.
   */
  @Index("idx_http_throttle_counters_expiry")
  @Column({ type: "timestamptz", name: "window_expires_at" })
  windowExpiresAt: Date;

  /**
   * When the block lifts, or `null` while the key is merely counting.
   *
   * A blocked key stops accumulating hits until this passes, matching what
   * `@nestjs/throttler`'s in-memory storage does -- otherwise a client that
   * keeps hammering through a block would extend its own sentence on a sliding
   * count, which is a different control from the one the decorators describe.
   */
  @Column({ type: "timestamptz", name: "blocked_until", nullable: true })
  blockedUntil: Date | null;
}
