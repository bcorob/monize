import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * One rate-limit or lockout counter, keyed by limiter and subject.
 *
 * The counters this replaces lived in a `Map` per process, which is two
 * separate defects in one field: a second replica enforces its own limit rather
 * than the deployment's, and a restart clears every lockout for free. A row
 * fixes both because the increment is a statement the database serializes.
 *
 * There is no `user_id`. These rows are written on the *failure* path, before
 * any identity is established -- a wrong 2FA code against a temp token, a
 * forgot-password request for an address that may not exist -- so `key` is an
 * opaque hash and the table is RLS-exempt
 * (`backend/src/common/db/rls-exempt-tables.ts`,
 * `docs/row-level-security-contract.md`).
 */
@Entity("auth_attempt_counters")
export class AuthAttemptCounter {
  /** Which limiter this counter belongs to, e.g. `2fa-user`, `forgot-password`. */
  @PrimaryColumn({ type: "text" })
  scope: string;

  /**
   * The subject within that scope: `sha256(email)`, `sha256(tempToken)`, or a
   * user id the caller already holds. Opaque by contract -- this table has no
   * owner column, so a key that identified a person would make it a directory
   * of who tried to log in.
   */
  @PrimaryColumn({ type: "text" })
  key: string;

  /** Failures seen inside the current window. */
  @Column({ type: "int", default: 0 })
  count: number;

  /**
   * When the current window ends.
   *
   * A row past this is not a counter of zero waiting to be deleted: the
   * incrementing statement resets `count` to 1 and moves the window in place,
   * and the daily sweep collects whatever nobody came back for.
   */
  @Index("idx_auth_attempt_counters_expiry")
  @Column({ type: "timestamptz", name: "window_expires_at" })
  windowExpiresAt: Date;
}
