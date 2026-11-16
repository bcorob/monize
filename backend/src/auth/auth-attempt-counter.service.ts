import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";

/**
 * How a further failure inside a live window treats the window's end.
 *
 * The two shapes are different security controls, and the one that suits a
 * per-email send throttle silently weakens a lockout counter -- so the call
 * site spells it and there is no safe default to fall into.
 *
 * - `fixed` -- the first attempt sets the end and nothing moves it, so N
 *   attempts are allowed per window however they are spaced. What the
 *   forgot-password and resend-verification throttles have always done; their
 *   `windowStart` field was never pushed out by a refused send.
 * - `sliding` -- every attempt pushes the end out, so a count only lapses after
 *   a full quiet window. What the 2FA and step-up limiters did as `Map`
 *   entries, each of which wrote `expiresAt: Date.now() + window` on *every*
 *   failure. It is the stronger control: under `fixed`, an attacker pacing
 *   themselves at one attempt per window never accumulates, so the tenth
 *   failure that writes `users.locked_until` is never reached.
 */
export type AttemptWindow = "fixed" | "sliding";

/**
 * Every rate-limit and lockout counter the auth layer keeps, on rows.
 *
 * What this replaces was a `Map` per limiter per process. That is two defects
 * wearing one field: two replicas enforce "three attempts" twice, and a restart
 * -- a rollout, a crash, an OOM kill -- hands an attacker a fresh allowance for
 * free. A row fixes both, because the increment below is one statement and the
 * database decides the order.
 *
 * Scopes and keys are the contract between replicas: two processes must spell a
 * limiter the same way or they are counting different things. Callers pass a
 * literal scope and a key that is already opaque -- `sha256(email)`,
 * `sha256(tempToken)`, a user id. Never the secret itself: this table has no
 * owner column and is RLS-exempt, so a raw key would be readable by every
 * session (`docs/row-level-security-contract.md`).
 */
@Injectable()
export class AuthAttemptCounterService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Count one failure and return the window's running total.
   *
   * One statement, so the count a caller compares against its threshold is the
   * count the database wrote, not a read another replica has already
   * invalidated. An expired window is reset in place rather than deleted: a row
   * past `window_expires_at` restarts at 1 and moves its window, which is what
   * makes the daily sweep (`AuthStateSweeperService`) a collection of garbage
   * and never a part of the limit.
   *
   * `window` decides what a further failure does to a window that is still
   * live, and the caller must say which control it is running -- see
   * `AttemptWindow`. Getting it wrong does not fail: it quietly turns a lockout
   * into a rate limit.
   *
   * **It runs outside the caller's transaction, deliberately.** A failure
   * counter exists to be recorded on the path that then *refuses* the request,
   * and a refusal usually throws -- so an increment joined to the caller's
   * transaction would roll back with it, and the limiter would count every
   * attempt as zero. `runOutsideActiveScopedManager` gives this statement its
   * own connection and its own commit; with no ambient transaction (the login
   * and 2FA paths have none) it is a no-op. The cost is one pooled connection
   * for the length of one statement, on a path that is already failing.
   */
  async increment(
    scope: string,
    key: string,
    windowMs: number,
    window: AttemptWindow,
  ): Promise<{ count: number; windowExpiresAt: Date }> {
    const rows = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO auth_attempt_counters (scope, key, count, window_expires_at)
           VALUES ($1, $2, 1, CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval)
           ON CONFLICT (scope, key) DO UPDATE
              SET count = CASE
                    WHEN auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP THEN 1
                    ELSE auth_attempt_counters.count + 1
                  END,
                  window_expires_at = CASE
                    WHEN $4::boolean
                      OR auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP
                      THEN CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval
                    ELSE auth_attempt_counters.window_expires_at
                  END
           RETURNING count AS count, window_expires_at AS window_expires_at`,
          [scope, key, Math.round(windowMs), window === "sliding"],
        ),
      ),
    );
    const [row] = returnedRows<{
      count: number | string;
      window_expires_at: Date | string;
    }>(rows);
    return {
      count: Number(row.count),
      windowExpiresAt:
        row.window_expires_at instanceof Date
          ? row.window_expires_at
          : new Date(row.window_expires_at),
    };
  }

  /**
   * Add `by` to a counter whose window ends at the next UTC midnight, and
   * return the window's running total.
   *
   * For daily budgets (the AI and MCP write caps), where the day is the
   * window. Both the amount and the day boundary are the database's: one
   * statement whatever `by` is, and the window end is computed from the
   * database clock (`date_trunc('day', now() AT TIME ZONE 'UTC') + 1 day`,
   * back to `timestamptz`) rather than as a duration measured on this process's
   * clock, so replicas whose clocks disagree still share one midnight. The
   * window is fixed: the first write of a day sets its end and later writes
   * leave it.
   *
   * Runs outside the caller's transaction for the reason `increment` gives.
   */
  async incrementUntilUtcMidnight(
    scope: string,
    key: string,
    by: number,
  ): Promise<{ count: number; windowExpiresAt: Date }> {
    const rows = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO auth_attempt_counters (scope, key, count, window_expires_at)
           VALUES ($1, $2, $3,
                   (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC')
           ON CONFLICT (scope, key) DO UPDATE
              SET count = CASE
                    WHEN auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP THEN EXCLUDED.count
                    ELSE auth_attempt_counters.count + EXCLUDED.count
                  END,
                  window_expires_at = CASE
                    WHEN auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP
                      THEN EXCLUDED.window_expires_at
                    ELSE auth_attempt_counters.window_expires_at
                  END
           RETURNING count AS count, window_expires_at AS window_expires_at`,
          [scope, key, Math.round(by)],
        ),
      ),
    );
    const [row] = returnedRows<{
      count: number | string;
      window_expires_at: Date | string;
    }>(rows);
    return {
      count: Number(row.count),
      windowExpiresAt:
        row.window_expires_at instanceof Date
          ? row.window_expires_at
          : new Date(row.window_expires_at),
    };
  }

  /**
   * How many failures the current window holds, or 0 when it has passed.
   *
   * The expiry is compared in SQL rather than against a clock this process
   * holds: two replicas disagreeing by a few seconds would otherwise disagree
   * about whether somebody is locked out.
   */
  async peek(scope: string, key: string): Promise<number> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT count AS count
           FROM auth_attempt_counters
          WHERE scope = $1
            AND key = $2
            AND window_expires_at >= CURRENT_TIMESTAMP`,
        [scope, key],
      ),
    );
    const [row] = returnedRows<{ count: number | string }>(rows);
    return row ? Number(row.count) : 0;
  }

  /** Clear the counter -- what a success does. Missing row is the same answer. */
  async reset(scope: string, key: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `DELETE FROM auth_attempt_counters WHERE scope = $1 AND key = $2`,
        [scope, key],
      ),
    );
  }
}
