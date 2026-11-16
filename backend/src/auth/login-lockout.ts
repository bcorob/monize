import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";

/** Failed passwords that lock the account. */
export const LOGIN_LOCKOUT_THRESHOLD = 5;

/** The first lock's length; each further run of five doubles it. */
export const LOGIN_LOCKOUT_BASE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The most doublings a lock gets: 30 minutes * 2^3 = 4 hours. Without a cap the
 * window grew without bound, so anyone who knew an address could push the lock
 * out indefinitely a handful of guesses at a time (and a large enough exponent
 * overflowed the interval and turned the login into a 500).
 */
export const LOGIN_LOCKOUT_MAX_DOUBLINGS = 3;

/** The longest lock one failure can set: `BASE * 2^MAX_DOUBLINGS`. */
export const LOGIN_LOCKOUT_MAX_MS =
  LOGIN_LOCKOUT_BASE_MS * 2 ** LOGIN_LOCKOUT_MAX_DOUBLINGS;

/**
 * How long after a lock has expired the escalation is forgotten. The next
 * failure after that counts as the first again, rather than re-locking at the
 * escalated length on a single attempt.
 */
export const LOGIN_LOCKOUT_DECAY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface FailedLoginResult {
  attempts: number;
  justLocked: boolean;
  lockedUntil: Date | null;
}

const toDate = (value: Date | string | null): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(value);

/**
 * Record one failed password in a single guarded statement: increment the
 * counter and, in the *same* UPDATE, lock the account when that increment
 * crosses the threshold. Returns what the database committed, plus whether this
 * write is the one that moved the row from not-locked to locked.
 *
 * - **Atomic.** The count, the decay and the lock are all decided from the row
 *   the UPDATE locked, so a concurrent failure cannot interleave between a read
 *   and the write (the reason this is one statement, not two).
 * - **Bounded.** The lock is `BASE * 2^min(floor(n / THRESHOLD) - 1,
 *   MAX_DOUBLINGS)`, so it never exceeds `LOGIN_LOCKOUT_MAX_MS`.
 * - **Decaying.** When the stored lock expired more than `LOGIN_LOCKOUT_DECAY_MS`
 *   ago the old count is discarded and this failure counts as the first; the
 *   stale `locked_until` is cleared with it, so the decay fires once rather than
 *   on every later failure (which would stop the account ever locking again).
 *   A count that never reached the threshold has no lock to date it by and does
 *   not decay; its worst case is one lock of `BASE` length.
 * - **One email per lockout.** `justLocked` compares the pre-update
 *   `locked_until` (from the CTE, since `RETURNING` sees only the new row)
 *   against the new one. The CTE reads it `FOR UPDATE`: a plain read takes the
 *   statement's snapshot, so a failure queued behind the one that locked the
 *   row still saw "not locked" and every concurrent failure past the threshold
 *   reported itself as the transition. A locking read waits for the row and
 *   returns the committed version the UPDATE then writes over.
 *
 * Returns `attempts: 0` / `justLocked: false` when no row matched, so a caller
 * cannot mistake a missing user for a first failed attempt.
 */
export async function recordFailedLogin(
  manager: EntityManager,
  userId: string,
): Promise<FailedLoginResult> {
  const result: unknown = await manager.query(
    `WITH prev AS (
       SELECT id, locked_until FROM users WHERE id = $1 FOR UPDATE
     )
     UPDATE users u
        SET failed_login_attempts = CASE
              WHEN u.locked_until IS NOT NULL
                   AND u.locked_until <= CURRENT_TIMESTAMP - ($5::bigint * INTERVAL '1 millisecond')
                THEN 1
              ELSE u.failed_login_attempts + 1
            END,
            locked_until = CASE
              WHEN (CASE
                      WHEN u.locked_until IS NOT NULL
                           AND u.locked_until <= CURRENT_TIMESTAMP - ($5::bigint * INTERVAL '1 millisecond')
                        THEN 1
                      ELSE u.failed_login_attempts + 1
                    END) >= $2
                THEN CURRENT_TIMESTAMP + (
                  ROUND(
                    $3::numeric
                    * power(
                        2,
                        LEAST(
                          floor(
                            (CASE
                               WHEN u.locked_until IS NOT NULL
                                    AND u.locked_until <= CURRENT_TIMESTAMP - ($5::bigint * INTERVAL '1 millisecond')
                                 THEN 1
                               ELSE u.failed_login_attempts + 1
                             END)::numeric / $2
                          ) - 1,
                          $4::numeric
                        )
                      )
                  )::bigint * INTERVAL '1 millisecond'
                )
              WHEN u.locked_until IS NOT NULL
                   AND u.locked_until <= CURRENT_TIMESTAMP - ($5::bigint * INTERVAL '1 millisecond')
                THEN NULL
              ELSE u.locked_until
            END
       FROM prev
      WHERE u.id = prev.id
      RETURNING u.failed_login_attempts AS attempts,
                u.locked_until AS new_locked_until,
                prev.locked_until AS old_locked_until`,
    [
      userId,
      LOGIN_LOCKOUT_THRESHOLD,
      LOGIN_LOCKOUT_BASE_MS,
      LOGIN_LOCKOUT_MAX_DOUBLINGS,
      LOGIN_LOCKOUT_DECAY_MS,
    ],
  );
  const updated = returnedRows<{
    attempts: number | string;
    new_locked_until: Date | string | null;
    old_locked_until: Date | string | null;
  }>(result);
  if (updated.length === 0) {
    return { attempts: 0, justLocked: false, lockedUntil: null };
  }
  const row = updated[0];
  const now = Date.now();
  const newLockedUntil = toDate(row.new_locked_until);
  const oldLockedUntil = toDate(row.old_locked_until);
  const wasLocked = oldLockedUntil != null && oldLockedUntil.getTime() > now;
  const isLocked = newLockedUntil != null && newLockedUntil.getTime() > now;
  return {
    attempts: Number(row.attempts),
    justLocked: !wasLocked && isLocked,
    lockedUntil: newLockedUntil,
  };
}
