import { Injectable, Logger } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { DataSource } from "typeorm";

import { returnedRows } from "../db/query-result";
import { runOutsideActiveScopedManager, withScopedDb } from "../db/scoped-db";
import { withSystemContext } from "../db/with-context";

/**
 * What `increment` owes its caller, spelled out here rather than imported.
 *
 * `@nestjs/throttler` does not re-export `ThrottlerStorageRecord` from its
 * barrel, and reaching into `@nestjs/throttler/dist/...` is the deep-path shape
 * that type-checks under `tsc` and then fails to resolve under `ts-jest` --
 * `ScopedDbIsolation` in `common/db/scoped-db.ts` is spelled out for exactly
 * that reason. TypeScript is structural, so `implements ThrottlerStorage` still
 * checks this against the library's own signature: a field renamed upstream
 * fails the build here rather than silently returning the wrong shape.
 */
export interface ThrottleRecord {
  totalHits: number;
  /** Whole seconds until the counting window ends. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Whole seconds until a block lifts; `0` when nothing is blocked. */
  timeToBlockExpire: number;
}

/**
 * The HTTP throttler's counters, on a row instead of in this process's memory.
 *
 * `ThrottlerModule.forRoot` with no `storage` keeps a `Map` in the guard, so
 * every `@Throttle` cap becomes limit x replicas: login's 5-per-15-minutes is
 * 10 across two pods, and a rollout hands the next attempt a clean count. Bound
 * only in `CLUSTER_MODE=multi`; `single` keeps the library default, which is
 * correct there and costs no write.
 *
 * This is the cheap first gate, not the correctness gate. Every authentication
 * route also carries `auth_attempt_counters` beneath it (task A2), which is a
 * logged table and a deliberate refusal. That is what makes failing **open**
 * here the right trade: a database blip would otherwise turn every guarded
 * request into a 500 raised before the handler decides anything, and readiness
 * already removes a replica that has lost its database.
 *
 * `docs/specs/horizontal-scaling.md` (WP2) has the design; the table's
 * `UNLOGGED` rationale is in its migration.
 */
@Injectable()
export class PostgresThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PostgresThrottlerStorage.name);

  /**
   * When the fail-open path last logged.
   *
   * Process-local on purpose, and not a counter anybody reads: it exists so a
   * database outage produces one line a minute instead of one per request. A
   * log throttle, never a rate limit.
   */
  private lastFailureLoggedAt = 0;

  /**
   * The last structural failure seen, or `null` while the storage is working.
   *
   * A structural failure -- a missing relation, a privilege the runtime role
   * never had, a statement the server will not parse -- does not heal when the
   * connection comes back, so folding it into the once-a-minute blip line hides
   * a rate limiter that has silently stopped existing. `/health` reads this.
   */
  private structuralFailure: string | null = null;

  /**
   * Keys this replica has seen the database refuse, and until when.
   *
   * Consulted before the statement, which is what makes a refusal cheap. Sound
   * because a block in this schema only moves forward or lapses: nothing
   * shortens `blocked_until`, and the sweeper deliberately spares a blocked
   * row. So this can only refuse during a period the database would also have
   * refused, and never allows a request the database would have blocked. It
   * needs no cross-replica agreement: each replica learns a block from its own
   * first refused request.
   */
  private readonly blockedUntilByKey = new Map<string, number>();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * What `/health` reports: `null` while the limiter is working, otherwise the
   * structural failure that has silently disabled it.
   */
  degradedReason(): string | null {
    return this.structuralFailure;
  }

  /**
   * Count one request against `key`, and say whether it is now blocked.
   *
   * `ttl` and `blockDuration` are **milliseconds** (the library's units);
   * `timeToExpire` and `timeToBlockExpire` come back in **seconds**, which is
   * what `ThrottlerGuard` puts in the `Retry-After` header. Both conversions
   * are against the database's own clock, never this process's: two replicas
   * whose clocks differ by a second must not disagree about whether a window
   * has passed.
   *
   * One statement, because the count a caller compares against the limit has to
   * be the count the database wrote. A read-then-write would let two replicas
   * each see "4 of 5" and both allow the fifth.
   *
   * The three `CASE` expressions repeat the same guard sequence because a `SET`
   * list cannot read the value it is assigning, so "what are the hits now" has
   * to be spelled once per column. The sequence, in order:
   *
   *  1. **blocked and still serving it** -- nothing moves. Matching the
   *     library, a blocked key stops accumulating, so hammering through a block
   *     does not extend it.
   *  2. **blocked but the block has lapsed** -- a fresh window at one hit, the
   *     block cleared. The library resets the count here too.
   *  3. **window expired** -- a fresh window at one hit.
   *  4. **otherwise** -- one more hit in the live window, and the block is set
   *     if that hit passed the limit.
   *
   * **The window is fixed, not sliding, and that is a deliberate difference
   * from the storage this replaces.** `@nestjs/throttler`'s in-memory storage
   * schedules a timer per hit that decrements the count `ttl` later, so it
   * never allows more than `limit` in any sliding window. This resets the whole
   * count when the window passes, which admits up to `2 x limit` across a
   * boundary: five registrations at 14:59 and five more at 15:01 against a
   * 15-minute, 5-request cap. The trade is deliberate -- it is the same fixed
   * window `auth_attempt_counters` uses, it needs no per-hit row, and at two or
   * more replicas it is still strictly tighter than the `limit x replicas` the
   * in-memory storage gives -- but it is a weakening at one replica and is
   * named here rather than left for a reader to discover. The auth routes carry
   * `auth_attempt_counters` and `users.locked_until` beneath them;
   * `register`, `oauth/interaction`, `pat` and the `ai/*` spend limits do not.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const cached = this.cachedBlock(throttlerName, key);
    if (cached !== null) {
      // Already refused, and the block cannot have been shortened. Going to the
      // database here would turn every request of a client that is hammering
      // through its block into a transaction, a row lock and a dead tuple on
      // one hot page -- a rate limiter that amplifies load instead of shedding
      // it. The window figures are the block's, which is all the guard reads
      // while `isBlocked` is true.
      return {
        totalHits: 0,
        timeToExpire: cached,
        isBlocked: true,
        timeToBlockExpire: cached,
      };
    }

    try {
      // The guard runs before RequestContextInterceptor, so there is no ambient
      // identity to inherit -- and this table has no owner to establish one
      // for. runOutsideActiveScopedManager for the reason A2's counter uses it:
      // a count joined to a transaction that then refuses the request would
      // roll back with the refusal, and the limiter would count every attempt
      // as zero. With no ambient transaction it is a no-op.
      // Bounded, because the pool's acquire has no timeout of its own: under
      // saturation `withScopedDb` queues rather than throwing, so without a
      // deadline the fail-open path below is unreachable in exactly the
      // degradation it was written for -- a slow database rather than a dead
      // one -- and every request stalls in the guard.
      const rows = await withDeadline(
        runOutsideActiveScopedManager(() =>
          withSystemContext(() =>
            withScopedDb(this.dataSource, (manager) =>
              manager.query(
                `INSERT INTO http_throttle_counters AS t
                   (name, key, hits, window_expires_at, blocked_until)
               VALUES (
                 $1, $2, 1,
                 CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval,
                 CASE WHEN 1 > $4
                   THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                   ELSE NULL
                 END
               )
               ON CONFLICT (name, key) DO UPDATE
                  SET hits = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.hits
                        WHEN t.blocked_until IS NOT NULL THEN 1
                        WHEN t.window_expires_at < CURRENT_TIMESTAMP THEN 1
                        ELSE t.hits + 1
                      END,
                      window_expires_at = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.window_expires_at
                        WHEN t.blocked_until IS NOT NULL
                          OR t.window_expires_at < CURRENT_TIMESTAMP
                          THEN CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval
                        ELSE t.window_expires_at
                      END,
                      blocked_until = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.blocked_until
                        WHEN t.blocked_until IS NOT NULL THEN
                          CASE WHEN 1 > $4
                            THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                            ELSE NULL
                          END
                        WHEN t.window_expires_at < CURRENT_TIMESTAMP THEN
                          CASE WHEN 1 > $4
                            THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                            ELSE NULL
                          END
                        WHEN t.hits + 1 > $4
                          THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                        ELSE t.blocked_until
                      END
               RETURNING hits AS hits,
                         window_expires_at AS window_expires_at,
                         blocked_until AS blocked_until,
                         CURRENT_TIMESTAMP AS db_now`,
                [
                  throttlerName,
                  key,
                  Math.round(ttl),
                  limit,
                  Math.round(blockDuration),
                ],
              ),
            ),
          ),
        ),
        STATEMENT_DEADLINE_MS,
      );

      const [row] = returnedRows<{
        hits: number | string;
        window_expires_at: Date | string;
        blocked_until: Date | string | null;
        db_now: Date | string;
      }>(rows);

      const now = toDate(row.db_now).getTime();
      const blockedUntil =
        row.blocked_until === null ? null : toDate(row.blocked_until).getTime();
      const isBlocked = blockedUntil !== null && blockedUntil > now;

      this.structuralFailure = null;
      const timeToBlockExpire = isBlocked ? toSeconds(blockedUntil - now) : 0;
      if (isBlocked) {
        this.blockedUntilByKey.set(
          cacheKey(throttlerName, key),
          Date.now() + timeToBlockExpire * 1000,
        );
      }

      return {
        totalHits: Number(row.hits),
        // Never negative. While a key is blocked its window is frozen, so once
        // the window passes but the block runs on, the raw difference goes
        // negative and the guard puts it in `X-RateLimit-Reset` -- a header
        // telling a client to come back in the past.
        timeToExpire: Math.max(
          0,
          toSeconds(toDate(row.window_expires_at).getTime() - now),
        ),
        isBlocked,
        // Zero rather than a negative when nothing is blocked: the guard reads
        // this only while blocked, and a Retry-After of "-1763" would be the
        // kind of header that sends somebody looking for a bug that is not one.
        timeToBlockExpire,
      };
    } catch (error) {
      this.reportFailure(error);
      // Fail open. A closed throttler takes the whole API down with the
      // database, before any handler runs, and the readiness probe has already
      // removed this replica from the load balancer. What is lost is one
      // window's leniency on routes whose real refusal is a row elsewhere.
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /**
   * A blip gets one line a minute; a structural failure gets one every time.
   *
   * The difference matters because they are not the same event. A connection
   * that comes back restores the limiter on its own; a missing table, a missing
   * grant or a statement the server will not parse leaves every HTTP rate limit
   * in the deployment switched off until somebody notices -- and the routes
   * with no second control (`register`, `oauth/interaction`, `pat`, the `ai/*`
   * spend caps) have nothing beneath them. Recorded as well as logged, so
   * `/health` can say it rather than leaving it to whoever greps.
   */
  private reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : "";

    if (STRUCTURAL_SQLSTATES.has(code)) {
      this.structuralFailure = `${code}: ${message}`;
      this.logger.error(
        `Rate limiting is DISABLED: the counters table cannot be written and ` +
          `this will not heal on its own (${code}). Every HTTP rate limit in ` +
          `this deployment is off until it is fixed: ${message}`,
      );
      return;
    }

    const now = Date.now();
    if (now - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastFailureLoggedAt = now;
    this.logger.error(
      `Rate-limit counters are unreachable; the HTTP throttler is failing ` +
        `open until the database returns: ${message}`,
    );
  }

  /** Seconds left on a block this replica already knows about, or `null`. */
  private cachedBlock(throttlerName: string, key: string): number | null {
    const entry = this.blockedUntilByKey.get(cacheKey(throttlerName, key));
    if (entry === undefined) {
      return null;
    }
    const remainingMs = entry - Date.now();
    if (remainingMs <= 0) {
      // Lapsed: drop it so the map cannot grow without bound, and let the next
      // request go to the database, which is the only thing that can reopen the
      // window.
      this.blockedUntilByKey.delete(cacheKey(throttlerName, key));
      return null;
    }
    return Math.ceil(remainingMs / 1000);
  }
}

/** One map key for the table's composite primary key. */
function cacheKey(throttlerName: string, key: string): string {
  return `${throttlerName}\u0000${key}`;
}

/**
 * SQLSTATEs that are not a blip.
 *
 * A relation that does not exist, a privilege the runtime role was never
 * granted and a statement the server will not parse do not heal when the
 * connection returns, so they are reported every time rather than once a
 * minute, and they are what `/health` surfaces.
 */
const STRUCTURAL_SQLSTATES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42501", // insufficient_privilege
  "42601", // syntax_error
  "42883", // undefined_function
  "42P10", // invalid_column_reference (a bad ON CONFLICT target)
]);

/** How long the counting statement may take before the storage fails open. */
export const STATEMENT_DEADLINE_MS = 2_000;

/** Fail a promise that has not settled in time, so the guard cannot stall. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the rate-limit statement did not answer within ${ms}ms`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shortest gap between two fail-open log lines. */
export const FAILURE_LOG_INTERVAL_MS = 60_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Milliseconds to whole seconds, the way `@nestjs/throttler`'s own storage
 * rounds them (`Math.ceil`), so a header this produces matches one the
 * in-process storage would have produced for the same instant.
 */
function toSeconds(milliseconds: number): number {
  return Math.ceil(milliseconds / 1000);
}
