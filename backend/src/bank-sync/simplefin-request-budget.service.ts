import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb, getActiveScopedManager } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";

export const SIMPLEFIN_DAILY_REQUEST_LIMIT = 24;
export interface SimplefinRequestBudget {
  remaining: number;
  nextEligibleAt: string | null;
}
export type SimplefinReservation = SimplefinRequestBudget & {
  allowed: boolean;
};

/** All request-budget writers lock the owned credential row (after the owner row) before counting/inserting. */
@Injectable()
export class SimplefinRequestBudgetService {
  constructor(private readonly dataSource: DataSource) {}

  async status(
    userId: string,
    credentialId: string,
  ): Promise<SimplefinRequestBudget> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.requireCredential(m, userId, credentialId, false);
      return this.readBudget(m, userId, credentialId);
    });
  }

  /** The caller must await commit before HTTP. A failed HTTP attempt still spends its reservation. */
  async reserve(
    userId: string,
    credentialId: string,
    count = 1,
  ): Promise<SimplefinReservation> {
    if (getActiveScopedManager())
      throw new Error(
        "Reserve SimpleFIN requests outside an active database transaction",
      );
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > SIMPLEFIN_DAILY_REQUEST_LIMIT
    )
      throw new Error("Invalid SimpleFIN reservation size");
    return withScopedDb(this.dataSource, async (m) => {
      // The owner row first, then the credential: the SimpleFIN lock order
      // setup and discovery take. The INSERT below takes FOR KEY SHARE on the
      // users row through its foreign key anyway; taken only there, after the
      // credential, it waited on a discovery holding the user FOR UPDATE while
      // that discovery waited on this credential, and PostgreSQL broke the
      // cycle with 40P01 on one of them.
      await m.query("SELECT id FROM users WHERE id = $1 FOR KEY SHARE", [
        userId,
      ]);
      await this.requireCredential(m, userId, credentialId, true);
      await m.query(
        "DELETE FROM bank_sync_provider_requests WHERE credential_id=$1 AND user_id=$2 AND requested_at <= clock_timestamp() - INTERVAL '24 hours'",
        [credentialId, userId],
      );
      const budget = await this.readBudget(m, userId, credentialId);
      if (budget.remaining < count) return { ...budget, allowed: false };
      await m.query(
        "INSERT INTO bank_sync_provider_requests (user_id, credential_id, requested_at) SELECT $1, $2, clock_timestamp() FROM generate_series(1, $3::integer)",
        [userId, credentialId, count],
      );
      const after = await this.readBudget(m, userId, credentialId);
      return { ...after, allowed: true };
    });
  }

  private async requireCredential(
    m: EntityManager,
    userId: string,
    credentialId: string,
    lock: boolean,
  ): Promise<void> {
    const rows: { id: string }[] = await m.query(
      `SELECT id FROM bank_sync_credentials WHERE id = $1 AND user_id = $2 AND provider = 'simplefin'${lock ? " FOR UPDATE" : ""}`,
      [credentialId, userId],
    );
    if (rows.length === 0)
      throw new NotFoundException(
        tr(
          "errors.bankSync.simplefinCredentialsMissing",
          "Connect SimpleFIN before syncing accounts.",
        ),
      );
  }

  private async readBudget(
    m: EntityManager,
    userId: string,
    credentialId: string,
  ): Promise<SimplefinRequestBudget> {
    const rows: { used: string; next_at: Date | null }[] = await m.query(
      `SELECT COUNT(*)::text AS used, MIN(requested_at) + INTERVAL '24 hours' AS next_at
       FROM bank_sync_provider_requests
       WHERE credential_id = $1 AND user_id = $2
         AND requested_at > clock_timestamp() - INTERVAL '24 hours'`,
      [credentialId, userId],
    );
    const remaining = Math.max(
      0,
      SIMPLEFIN_DAILY_REQUEST_LIMIT - Number(rows[0].used),
    );
    return {
      remaining,
      nextEligibleAt:
        remaining === 0 && rows[0].next_at
          ? rows[0].next_at.toISOString()
          : null,
    };
  }
}
