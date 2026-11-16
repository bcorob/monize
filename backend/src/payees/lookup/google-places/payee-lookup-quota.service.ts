import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../../common/db/scoped-db";
import { withSystemContext } from "../../../common/db/with-context";
import { GOOGLE_PLACES_QUOTA_TIMEZONE } from "./google-places-cap";

/**
 * Whose key a request would spend, and what limit applies to it.
 *
 * `operator` is the deployment's `GOOGLE_PLACES_API_KEY`, counted once for the
 * whole instance; `user` is a key the user configured, counted per user. The
 * two are separate counters because they are separate bills.
 */
export type QuotaScope =
  | { kind: "operator"; capEnabled: boolean; cap: number }
  | { kind: "user"; userId: string; capEnabled: boolean; cap: number };

/**
 * The monthly request cap on Google Places lookups, claimed one request at a
 * time.
 *
 * The claim is a single conditional upsert -- mechanism 3 in
 * `docs/concurrency-and-idempotency.md`: the row is created at 1 or
 * incremented, and the `WHERE` refuses to increment past the cap, so the
 * database decides and two replicas racing for the last slot produce one
 * winner. Zero rows back means the cap is reached. A read-then-write would let
 * both callers past a cap of one.
 *
 * **The claim commits before the request goes out** (INV-PAYEE-002). Google
 * bills an attempt whatever comes back, so a slot released because the request
 * then failed would under-count what the user is paying for -- and an
 * under-count is the direction that spends money. `runOutsideActiveScopedManager`
 * is what makes that true even when a caller happens to be inside a
 * transaction: the count of what has been spent must not be rolled back by
 * whatever operation discovered it, exactly as `ProviderHealthService` records
 * an outage outside the request that found it.
 *
 * The month is `to_char(now() AT TIME ZONE $tz, 'YYYY-MM')`, evaluated by
 * PostgreSQL rather than in JavaScript, so every replica rolls over on one
 * clock and no caller can disagree with the row it is incrementing. The zone
 * is `GOOGLE_PLACES_QUOTA_TIMEZONE` -- Pacific, because that is when GOOGLE's
 * free allowance resets, and a counter that rolls over first hands back a cap
 * the allowance behind it has not released yet.
 */
@Injectable()
export class PayeeLookupQuotaService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Take one request's worth of quota.
   *
   * @returns the count including this request, or `null` when the cap is
   *   already reached. `null` is a decision, not a failure: the caller falls
   *   back to the AI adapter.
   */
  async claim(scope: QuotaScope): Promise<number | null> {
    return scope.kind === "user"
      ? this.claimUser(scope.userId, scope.capEnabled, scope.cap)
      : this.claimInstance(scope.capEnabled, scope.cap);
  }

  /**
   * Hand one claimed request back.
   *
   * The claim commits before the request goes out because Google bills an
   * attempt -- but a request Google ANSWERED WITH A REFUSAL was never served
   * and never billed, so the slot it spent is not a slot the user owes. The
   * Test button is the one caller: it is a diagnostic the user pressed, and a
   * rejected key would otherwise cost them a request every time they checked
   * whether they had fixed it.
   *
   * Deliberately not called from the lookup path. There the same 4xx is
   * indistinguishable, at the moment it arrives, from a key that was rejected
   * AFTER Google served something -- and over-counting a lookup costs the user
   * a request, while under-counting costs them a bill.
   *
   * `GREATEST(..., 0)` because a release is a compensation, not a ledger entry:
   * a month boundary crossed between the claim and the release would otherwise
   * drive the new month's row negative and hand out free quota.
   */
  async release(scope: QuotaScope): Promise<void> {
    const [sql, params] =
      scope.kind === "user"
        ? [
            `UPDATE payee_lookup_usage
                SET google_places_requests = GREATEST(google_places_requests - 1, 0)
              WHERE user_id = $1
                AND month = to_char(now() AT TIME ZONE $2, 'YYYY-MM')`,
            [scope.userId, GOOGLE_PLACES_QUOTA_TIMEZONE],
          ]
        : [
            `UPDATE google_places_instance_usage
                SET requests = GREATEST(requests - 1, 0)
              WHERE month = to_char(now() AT TIME ZONE $1, 'YYYY-MM')`,
            [GOOGLE_PLACES_QUOTA_TIMEZONE],
          ];

    const run = () =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));
    await runOutsideActiveScopedManager(() =>
      scope.kind === "user" ? run() : withSystemContext(run),
    );
  }

  /** What this scope has spent in the current billing month (Pacific). */
  async usedThisMonth(scope: QuotaScope): Promise<number> {
    return scope.kind === "user"
      ? this.readUsage(
          (m) =>
            m.query(
              `SELECT google_places_requests AS used FROM payee_lookup_usage
                WHERE user_id = $1
                  AND month = to_char(now() AT TIME ZONE $2, 'YYYY-MM')`,
              [scope.userId, GOOGLE_PLACES_QUOTA_TIMEZONE],
            ),
          false,
        )
      : this.readUsage(
          (m) =>
            m.query(
              `SELECT requests AS used FROM google_places_instance_usage
                WHERE month = to_char(now() AT TIME ZONE $1, 'YYYY-MM')`,
              [GOOGLE_PLACES_QUOTA_TIMEZONE],
            ),
          true,
        );
  }

  private async claimUser(
    userId: string,
    capEnabled: boolean,
    cap: number,
  ): Promise<number | null> {
    const rows = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO payee_lookup_usage (user_id, month, google_places_requests)
           VALUES ($1, to_char(now() AT TIME ZONE $4, 'YYYY-MM'), 1)
           ON CONFLICT (user_id, month) DO UPDATE
              SET google_places_requests = payee_lookup_usage.google_places_requests + 1
            WHERE $2::boolean = false
               OR payee_lookup_usage.google_places_requests < $3
        RETURNING google_places_requests AS used`,
          [userId, capEnabled, cap, GOOGLE_PLACES_QUOTA_TIMEZONE],
        ),
      ),
    );
    return this.claimedCount(rows);
  }

  /**
   * The operator's counter, under system context: the row belongs to the
   * deployment rather than to whoever's lookup happened to spend it, and the
   * table is RLS-exempt for that reason.
   */
  private async claimInstance(
    capEnabled: boolean,
    cap: number,
  ): Promise<number | null> {
    const rows = await runOutsideActiveScopedManager(() =>
      withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.query(
            `INSERT INTO google_places_instance_usage (month, requests)
             VALUES (to_char(now() AT TIME ZONE $3, 'YYYY-MM'), 1)
             ON CONFLICT (month) DO UPDATE
                SET requests = google_places_instance_usage.requests + 1
              WHERE $1::boolean = false
                 OR google_places_instance_usage.requests < $2
          RETURNING requests AS used`,
            [capEnabled, cap, GOOGLE_PLACES_QUOTA_TIMEZONE],
          ),
        ),
      ),
    );
    return this.claimedCount(rows);
  }

  private async readUsage(
    read: (m: EntityManager) => Promise<unknown>,
    system: boolean,
  ): Promise<number> {
    const run = () =>
      withScopedDb(this.dataSource, (m) => read(m) as Promise<unknown>);
    // The operator's counter is read under system context, so it steps outside
    // an ambient transaction for the same reason `claimInstance` does -- but
    // here the consequence is sharper than a lost commit: `withScopedDb`
    // REFUSES to join a user-identity transaction under a system identity, so
    // without this a caller inside one gets IDENTITY_MISMATCH_MESSAGE instead
    // of a number. No current caller is inside a transaction (both are
    // controller-level), which is exactly why nothing caught the asymmetry
    // with the claim beside it.
    const rows = await (system
      ? runOutsideActiveScopedManager(() => withSystemContext(run))
      : run());
    const first = Array.isArray(rows) ? rows[0] : undefined;
    const used = (first as { used?: unknown } | undefined)?.used;
    return typeof used === "number" ? used : Number(used ?? 0) || 0;
  }

  /**
   * `RETURNING` on a refused upsert yields no rows, which is the cap being
   * reached. An `ON CONFLICT DO UPDATE ... WHERE` that matches nothing is the
   * only way this statement declines, so there is no other reading of an empty
   * result.
   */
  private claimedCount(rows: unknown): number | null {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const used = (rows[0] as { used?: unknown }).used;
    const parsed = typeof used === "number" ? used : Number(used);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
