import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { WarrantiesModule } from "@/warranties/warranties.module";
import { WarrantyExpiryReminderService } from "@/warranties/warranty-expiry-reminder.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * Warranty expiry reminders against a real PostgreSQL enforcing RLS
 * (docs/specs/warranty-tracker.md section 6.7, WTY-004, test matrix
 * "Reminders").
 *
 * What a mock cannot show and these do: that each threshold is written once
 * even when two replicas evaluate at the same instant (two evaluations race on
 * separate pooled connections, and the `idx_notifications_dedupe` unique index
 * is the arbiter, so exactly one insert wins each key and the loser counts
 * nothing); that a changed `expires_on` forms new keys and fires again
 * (example 4); that archived and lifetime warranties are never candidates; and
 * that the cross-user read and the per-user writes both pass the policies.
 *
 * The enforcement harness applies the migrations that create
 * `idx_notifications_dedupe` and the RLS policies on `warranties`.
 */
describe("Warranty expiry reminders (integration)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let reminders: WarrantyExpiryReminderService;

  let aliceId: string;
  let bobId: string;

  const runAt = (day: string) => new Date(`${day}T06:17:00.000Z`);

  interface NotificationRow {
    user_id: string;
    alert_type: string;
    severity: string;
    dedupe_key: string;
    target: string;
    period_start: string;
    data: Record<string, unknown>;
  }

  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => db.query(sql, params) as Promise<T[]>;

  const notifications = (): Promise<NotificationRow[]> =>
    query<NotificationRow>(
      `SELECT user_id, alert_type, severity, dedupe_key, target,
              TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start, data
         FROM notifications
        ORDER BY dedupe_key, user_id`,
    );

  const keys = async (): Promise<string[]> =>
    (await notifications()).map((row) => row.dedupe_key).sort();

  async function seedWarranty(
    userId: string,
    over: {
      name?: string;
      expiresOn?: string | null;
      isLifetime?: boolean;
      archived?: boolean;
    } = {},
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO warranties
         (user_id, name, purchase_date, expires_on, is_lifetime, archived_at)
       VALUES ($1, $2, '2026-01-01', $3, $4, $5)
       RETURNING id`,
      [
        userId,
        over.name ?? "Dishwasher",
        over.expiresOn === undefined ? "2026-11-10" : over.expiresOn,
        over.isLifetime ?? false,
        over.archived ? new Date() : null,
      ],
    );
    return row.id;
  }

  /** Both replicas evaluating at the same instant; the rows each one won. */
  const twice = async (now: Date): Promise<number> => {
    const [a, b] = await Promise.all([
      reminders.evaluate(now),
      reminders.evaluate(now),
    ]);
    return a.written + b.written;
  };

  /** Every day from `from` to `to`, inclusive. */
  const days = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (
      let d = new Date(`${from}T00:00:00Z`);
      d <= new Date(`${to}T00:00:00Z`);
      d = new Date(d.getTime() + 86_400_000)
    ) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([WarrantiesModule]);
    module = harness.module;
    db = harness.owner;
    reminders = module.get(WarrantyExpiryReminderService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanTables(db, [
      "notifications",
      "warranty_claims",
      "warranties",
      "user_preferences",
      "users",
    ]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
  });

  describe("the harness", () => {
    it("is enforcing row-level security and has the dedupe index the reminders rely on", async () => {
      const [index] = await query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_notifications_dedupe'`,
      );
      expect(index?.indexdef).toMatch(/UNIQUE/i);
      const [rls] = await query<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'warranties'`,
      );
      expect(rls?.relrowsecurity).toBe(true);
    });
  });

  describe("one row per threshold across two concurrent evaluations", () => {
    it("example 3: every day from 45 days out to the day after expiry writes :30, :7 and :0 once each", async () => {
      // Created on 2026-10-21 with 20 days left would fire :30 first; running
      // every day from 45 days out also covers truth table B's quiet rows.
      const warrantyId = await seedWarranty(aliceId);
      const run = days("2026-09-26", "2026-11-11");
      expect(run).toHaveLength(47);
      let won = 0;
      for (const day of run) won += await twice(runAt(day));

      const rows = await notifications();
      expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
        [30, 7, 0].map((m) => `wty:exp:${warrantyId}:2026-11-10:${m}`).sort(),
      );
      // Exactly one evaluation won each key; the loser counted nothing.
      expect(won).toBe(3);

      const byMark = (mark: number) =>
        rows.find((r) => r.dedupe_key.endsWith(`:${mark}`)) as NotificationRow;
      expect(byMark(30)).toMatchObject({
        user_id: aliceId,
        alert_type: "WARRANTY_EXPIRING",
        severity: "info",
        target: `/warranties/${warrantyId}`,
        period_start: "2026-10-11",
        data: {
          warrantyId,
          name: "Dishwasher",
          expiresOn: "2026-11-10",
          threshold: 30,
          daysLeft: 30,
        },
      });
      expect(byMark(7)).toMatchObject({
        alert_type: "WARRANTY_EXPIRING",
        severity: "warning",
        period_start: "2026-11-03",
        data: { threshold: 7, daysLeft: 7 },
      });
      expect(byMark(0)).toMatchObject({
        alert_type: "WARRANTY_EXPIRES_TODAY",
        severity: "warning",
        period_start: "2026-11-10",
        data: { threshold: 0, daysLeft: 0 },
      });
    });

    it("a warranty created with 20 days left fires :30 on its first tick, then only the later marks", async () => {
      const warrantyId = await seedWarranty(aliceId);
      expect(await twice(runAt("2026-10-21"))).toBe(1);
      expect(await twice(runAt("2026-10-22"))).toBe(0);
      expect(await twice(runAt("2026-11-03"))).toBe(1);
      expect(await twice(runAt("2026-11-10"))).toBe(1);
      expect(await keys()).toEqual(
        [30, 7, 0].map((m) => `wty:exp:${warrantyId}:2026-11-10:${m}`).sort(),
      );
    });

    it("writes nothing above 30 days or after the day of expiry", async () => {
      await seedWarranty(aliceId);
      await twice(runAt("2026-09-26")); // 45 days left
      await twice(runAt("2026-10-10")); // 31 days left
      await twice(runAt("2026-11-11")); // -1
      expect(await keys()).toEqual([]);
    });

    it("writes one row per warranty and per user, each under its owner", async () => {
      const aliceA = await seedWarranty(aliceId);
      const aliceB = await seedWarranty(aliceId, { name: "Laptop" });
      const bob = await seedWarranty(bobId, { name: "Fridge" });

      expect(await twice(runAt("2026-11-05"))).toBe(3); // 5 days left: the 7 mark

      const rows = await notifications();
      expect(rows.map((r) => [r.user_id, r.dedupe_key]).sort()).toEqual(
        [
          [aliceId, `wty:exp:${aliceA}:2026-11-10:7`],
          [aliceId, `wty:exp:${aliceB}:2026-11-10:7`],
          [bobId, `wty:exp:${bob}:2026-11-10:7`],
        ].sort(),
      );
    });

    it("counts the days in the user's timezone", async () => {
      const warrantyId = await seedWarranty(aliceId);
      await db.query(
        `INSERT INTO user_preferences (user_id, timezone) VALUES ($1, 'Pacific/Honolulu')
           ON CONFLICT (user_id) DO UPDATE SET timezone = 'Pacific/Honolulu'`,
        [aliceId],
      );
      // 06:17 UTC on 11-03 is 20:17 on 11-02 in Honolulu: 8 days, the 30 mark.
      await twice(runAt("2026-11-03"));
      const [row] = await notifications();
      expect(row).toMatchObject({
        dedupe_key: `wty:exp:${warrantyId}:2026-11-10:30`,
        period_start: "2026-11-02",
        data: { daysLeft: 8, threshold: 30 },
      });
    });
  });

  describe("example 4: a changed expires_on fires again", () => {
    it("keeps the old keys and forms new ones for the new date", async () => {
      const warrantyId = await seedWarranty(aliceId);
      await twice(runAt("2026-11-03")); // the 7 mark of 2026-11-10
      expect(await keys()).toEqual([`wty:exp:${warrantyId}:2026-11-10:7`]);

      await db.query(
        `UPDATE warranties SET expires_on = '2027-11-10' WHERE id = $1`,
        [warrantyId],
      );
      // Nothing for the old date's remaining marks, nothing a year out.
      for (const day of ["2026-11-04", "2026-11-10", "2026-11-11"]) {
        await twice(runAt(day));
      }
      expect(await keys()).toEqual([`wty:exp:${warrantyId}:2026-11-10:7`]);

      await twice(runAt("2027-10-11")); // 30 days before the new date
      expect(await keys()).toEqual(
        [
          `wty:exp:${warrantyId}:2026-11-10:7`,
          `wty:exp:${warrantyId}:2027-11-10:30`,
        ].sort(),
      );
    });
  });

  describe("not candidates", () => {
    it("never reminds about an archived or a lifetime warranty", async () => {
      await seedWarranty(aliceId, { archived: true });
      await seedWarranty(aliceId, { isLifetime: true, expiresOn: null });
      // A lifetime row that also carries a date is still lifetime.
      await seedWarranty(bobId, { isLifetime: true, expiresOn: "2026-11-10" });
      for (const day of ["2026-10-11", "2026-11-03", "2026-11-10"]) {
        expect(await twice(runAt(day))).toBe(0);
      }
      expect(await keys()).toEqual([]);
    });
  });
});
