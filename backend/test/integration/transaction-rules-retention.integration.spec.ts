import { DataSource } from "typeorm";

import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewRequestsExpiryService } from "@/ai-review/ai-review-requests-expiry.service";
import { TransactionRuleApplicationsRetentionService } from "@/transaction-rules/transaction-rule-applications-retention.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The two rule-side crons against a real PostgreSQL enforcing RLS. Nothing here
 * runs inside a request, so a sweep that reached only its own identity's rows
 * (or none) would show up as rows left behind; the system context is what makes
 * every user's rows visible to it.
 */
describe("rule application retention and AI review expiry (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let db: DataSource;
  let retention: TransactionRuleApplicationsRetentionService;
  let expiry: AiReviewRequestsExpiryService;

  let aliceId: string;
  let bobId: string;
  const rules: Record<string, string> = {};
  const txs: Record<string, string> = {};

  async function insertTx(userId: string, accountId: string): Promise<string> {
    const [tx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
       VALUES ($1, $2, '2026-03-10', -1, 'USD', 'UNRECONCILED') RETURNING id`,
      [userId, accountId],
    );
    return tx.id;
  }

  async function insertApplication(
    userId: string,
    ruleId: string,
    transactionId: string,
    daysAgo: number,
  ): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO transaction_rule_applications (user_id, rule_id, transaction_id, applied_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP - ($4 || ' days')::interval) RETURNING id`,
      [userId, ruleId, transactionId, String(daysAgo)],
    );
    return row.id;
  }

  async function insertRequest(
    userId: string,
    transactionId: string,
    fields: {
      status: string;
      claimedMinutesAgo?: number;
      expiresInMinutes: number;
    },
  ): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO ai_review_requests
         (user_id, transaction_id, instruction, status, claimed_by, claimed_at, expires_at)
       VALUES ($1, $2, 'look', $3,
               CASE WHEN $4::int IS NULL THEN NULL ELSE 'agent' END,
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE CURRENT_TIMESTAMP - ($4 || ' minutes')::interval END,
               CURRENT_TIMESTAMP + ($5 || ' minutes')::interval)
       RETURNING id`,
      [
        userId,
        transactionId,
        fields.status,
        fields.claimedMinutesAgo ?? null,
        String(fields.expiresInMinutes),
      ],
    );
    return row.id;
  }

  const applicationIds = async (): Promise<string[]> =>
    (
      await db.query(`SELECT id FROM transaction_rule_applications ORDER BY id`)
    ).map((r: { id: string }) => r.id);

  const requestState = async (id: string) =>
    (
      await db.query(
        `SELECT status, claimed_by, claimed_at FROM ai_review_requests WHERE id = $1`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionRulesModule,
      AiReviewModule,
    ]);
    db = harness.owner;
    retention = harness.module.get(TransactionRuleApplicationsRetentionService);
    expiry = harness.module.get(AiReviewRequestsExpiryService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "ai_review_requests",
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    for (const [name, userId] of [
      ["alice", aliceId],
      ["bob", bobId],
    ] as const) {
      const accountId = (
        await createTestAccount(db, userId, {
          name: `${name} checking`,
          currencyCode: "USD",
          openingBalance: 0,
          currentBalance: 0,
        })
      ).id;
      const [rule] = await db.query(
        `INSERT INTO transaction_rules (user_id, name, position) VALUES ($1, $2, 0) RETURNING id`,
        [userId, `${name} rule`],
      );
      rules[name] = rule.id;
      txs[name] = await insertTx(userId, accountId);
      txs[`${name}2`] = await insertTx(userId, accountId);
    }
  });

  describe("transaction rule application retention", () => {
    it("deletes old rows of every user, keeps recent ones, and a second run is a no-op", async () => {
      const oldAlice = await insertApplication(
        aliceId,
        rules.alice,
        txs.alice,
        400,
      );
      const oldBob = await insertApplication(bobId, rules.bob, txs.bob, 366);
      const recentAlice = await insertApplication(
        aliceId,
        rules.alice,
        txs.alice2,
        364,
      );
      const freshBob = await insertApplication(bobId, rules.bob, txs.bob2, 0);

      await expect(retention.purgeExpiredApplications()).resolves.toBe(2);

      const remaining = await applicationIds();
      expect(remaining).toEqual([recentAlice, freshBob].sort());
      expect(remaining).not.toContain(oldAlice);
      expect(remaining).not.toContain(oldBob);

      await expect(retention.purgeExpiredApplications()).resolves.toBe(0);
      expect(await applicationIds()).toEqual(remaining);
    });

    it("is a no-op on an empty table", async () => {
      await expect(retention.purgeExpiredApplications()).resolves.toBe(0);
    });
  });

  describe("AI review request expiry", () => {
    it("expires past-due open requests, releases stale claims, leaves fresh ones, and a second run is a no-op", async () => {
      const pastDuePending = await insertRequest(aliceId, txs.alice, {
        status: "pending",
        expiresInMinutes: -5,
      });
      const pastDueClaimed = await insertRequest(bobId, txs.bob, {
        status: "claimed",
        claimedMinutesAgo: 120,
        expiresInMinutes: -5,
      });
      const pastDueProposed = await insertRequest(aliceId, txs.alice2, {
        status: "proposed",
        claimedMinutesAgo: 10,
        expiresInMinutes: -1,
      });
      const staleClaim = await insertRequest(bobId, txs.bob2, {
        status: "claimed",
        claimedMinutesAgo: 90,
        expiresInMinutes: 60 * 24,
      });
      const [freshTx] = await db.query(
        `SELECT id FROM transactions WHERE user_id = $1 ORDER BY id LIMIT 1`,
        [aliceId],
      );
      const freshPending = await insertRequest(aliceId, freshTx.id, {
        status: "pending",
        expiresInMinutes: 60 * 24,
      });
      const [bobTx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         SELECT user_id, account_id, transaction_date, amount, currency_code, status
           FROM transactions WHERE id = $1 RETURNING id`,
        [txs.bob],
      );
      const freshClaim = await insertRequest(bobId, bobTx.id, {
        status: "claimed",
        claimedMinutesAgo: 5,
        expiresInMinutes: 60 * 24,
      });

      await expect(expiry.sweepQueue()).resolves.toEqual({
        expired: 3,
        released: 1,
      });

      for (const id of [pastDuePending, pastDueClaimed, pastDueProposed]) {
        expect((await requestState(id)).status).toBe("expired");
      }
      expect(await requestState(staleClaim)).toEqual({
        status: "pending",
        claimed_by: null,
        claimed_at: null,
      });
      expect((await requestState(freshPending)).status).toBe("pending");
      const fresh = await requestState(freshClaim);
      expect(fresh.status).toBe("claimed");
      expect(fresh.claimed_by).toBe("agent");

      await expect(expiry.sweepQueue()).resolves.toEqual({
        expired: 0,
        released: 0,
      });
    });
  });
});
