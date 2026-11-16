import { DataSource } from "typeorm";

import { SystemAlertService } from "@/system-alerts/system-alert.service";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { NotificationService } from "@/notification-center/notification.service";
import {
  NotificationSeverity,
  NotificationType,
} from "@/notification-center/entities/notification.entity";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * INV-ALERT-001's SQL-resident halves, against a real PostgreSQL.
 *
 * The unit spec proves what the service sends; these two properties live in
 * the database and a mocked `manager.query` cannot see either:
 *
 * 1. **The `ON CONFLICT` target parses and matches the partial index.** A
 *    conflict target naming an index predicate (`WHERE dedupe_key IS NOT
 *    NULL`) is accepted or rejected by the planner, not by TypeScript -- the
 *    same blindness that let provider-outage read an UPDATE's `[rows,
 *    rowCount]` tuple as a row.
 * 2. **Concurrent raises produce one row per recipient, and one email.** The
 *    index is the cross-replica arbiter; two mocked services cannot race, two
 *    real ones against one database can.
 *
 * `synchronize` builds the schema from entities and creates no partial
 * indexes, so the suite brings the database up to the real shape through
 * `applyRlsPolicies`, which applies the shipped migrations -- 179 among them,
 * since it references the RLS helpers -- and that is what creates
 * `idx_notifications_dedupe` here. Still the shipped SQL rather than a fixture,
 * so the migration and the service's conflict target cannot drift apart
 * silently. It used to read migration 170 directly, which stopped working the
 * day the table was renamed: 170 is guarded on the old name and correctly skips
 * a database where the table is already `notifications`, so nothing created the
 * index and every property here failed.
 *
 * Broken on purpose, both directions (CLAUDE.md 8.1): a conflict target that
 * no longer matches the index fails every test here (PostgreSQL refuses the
 * INSERT outright, so no alert is ever raised -- the loud failure). Removing
 * the ON CONFLICT clause alone stays green, and that is a finding worth
 * keeping: the INDEX is the arbiter, the loser's insert then throws instead
 * of no-oping, and the never-throws catch absorbs it into the same observable
 * outcome. The clause buys clean logs and an honest created-count, not the
 * invariant itself.
 */
describe("system alert dedupe against a real database", () => {
  let dataSource: DataSource;

  const emailsSent: Array<{ to: string; subject: string }> = [];

  const alertService = (): SystemAlertService => {
    const writeDoor = new NotificationService(dataSource);
    return new SystemAlertService(
      dataSource,
      {
        getStatus: () => ({ configured: true }),
        sendMail: async (to: string, subject: string) => {
          emailsSent.push({ to, subject });
        },
      } as never,
      {
        translate: (_key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? _key,
      } as never,
      // The real claim service: `emailDedupeKey` is arbitrated by a second
      // real table, and a mock that always wins would make the collapse
      // assertion below vacuous.
      new JobClaimService(dataSource),
      // The real write door on the real connection: what this file proves is
      // that PostgreSQL's own planner refuses the second insert, which is a
      // property of the statement the door issues.
      writeDoor,
      // The admin fan-out goes through the dispatch seam. Forward `notify` to the
      // same real write door so the guarded insert still lands on the real
      // connection (the ON CONFLICT arbitration this file proves), without pulling
      // the push / notification-email fan-out into a dedupe test.
      {
        notify: (userId: string, alert: unknown) =>
          writeDoor.create(userId, alert as never),
      } as never,
    );
  };

  const input = (dedupeKey: string) => ({
    type: NotificationType.BACKUP_FAILED,
    severity: NotificationSeverity.CRITICAL,
    title: "Automatic backup failed",
    message: "The automatic backup for u failed: disk full",
    data: { system: true, affectedUserId: "u" },
    dedupeKey,
  });

  const alertRows = (): Promise<
    Array<{ user_id: string; dedupe_key: string; is_email_sent: boolean }>
  > =>
    dataSource.query(
      `SELECT user_id, dedupe_key, is_email_sent
         FROM notifications ORDER BY user_id`,
    );

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    // The partial unique index the service's ON CONFLICT names, from the
    // shipped migrations (see the note above). The owner still bypasses the
    // policies this also creates, so the queries below read every row.
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    emailsSent.length = 0;
    await cleanTables(dataSource, ["notifications", "job_claims", "users"]);
  });

  it("concurrent same-key raises land one row per admin, and each admin is emailed once", async () => {
    await createTestUserDirect(dataSource, {
      email: "ops-a@example.com",
      role: "admin",
    });
    await createTestUserDirect(dataSource, {
      email: "ops-b@example.com",
      role: "admin",
    });
    // A non-admin proves the audience: no row, no email.
    await createTestUserDirect(dataSource, { email: "user@example.com" });

    const key = "BACKUP_FAILED:u:2026-08-30";
    const results = await Promise.all([
      alertService().raiseAdminAlert(input(key)),
      alertService().raiseAdminAlert(input(key)),
      alertService().raiseAdminAlert(input(key)),
    ]);

    const rows = await alertRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dedupe_key === key)).toBe(true);
    expect(rows.every((r) => r.is_email_sent === true)).toBe(true);

    // Exactly one email per admin across the three "replicas": each row's
    // insert winner sent it, whoever that was.
    expect(emailsSent.map((e) => e.to).sort()).toEqual([
      "ops-a@example.com",
      "ops-b@example.com",
    ]);
    expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(2);
    expect(results.reduce((sum, r) => sum + r.emailed, 0)).toBe(2);
  });

  it("a later raise in the same bucket is a no-op; a new bucket is a fresh alert", async () => {
    const admin = await createTestUserDirect(dataSource, {
      email: "ops@example.com",
      role: "admin",
    });

    const first = await alertService().raiseAdminAlert(
      input("BACKUP_FAILED:u:2026-08-30"),
    );
    const repeat = await alertService().raiseAdminAlert(
      input("BACKUP_FAILED:u:2026-08-30"),
    );
    const nextDay = await alertService().raiseAdminAlert(
      input("BACKUP_FAILED:u:2026-08-31"),
    );

    expect(first.created).toBe(1);
    expect(repeat).toEqual({ created: 0, emailed: 0 });
    expect(nextDay.created).toBe(1);
    const rows = await alertRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === admin.id)).toBe(true);
  });

  it("raiseUserAlert dedupes per user without touching other users' keys", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "b@example.com",
    });

    const perUser = {
      type: NotificationType.SCHEDULED_POST_FAILED,
      severity: NotificationSeverity.WARNING,
      title: "Rent could not be posted",
      message: "It failed",
      data: { system: true },
      dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-08-30",
    };

    expect(await alertService().raiseUserAlert(userA.id, perUser)).toEqual({
      created: true,
    });
    expect(await alertService().raiseUserAlert(userA.id, perUser)).toEqual({
      created: false,
    });
    // Same key, different user: the index is per (user_id, dedupe_key).
    expect(await alertService().raiseUserAlert(userB.id, perUser)).toEqual({
      created: true,
    });

    expect(await alertRows()).toHaveLength(2);
    expect(emailsSent).toEqual([]);
  });

  it("collapses the email of several same-cause alerts while writing every row", async () => {
    await createTestUserDirect(dataSource, {
      email: "ops@example.com",
      role: "admin",
    });

    // One broken volume, three affected users: three rows naming who lost a
    // backup, one message to the administrator.
    for (const user of ["u-1", "u-2", "u-3"]) {
      await alertService().raiseAdminAlert({
        ...input(`BACKUP_FAILED:${user}:2026-08-30`),
        emailDedupeKey: "BACKUP_FAILED:2026-08-30",
      });
    }

    expect(await alertRows()).toHaveLength(3);
    expect(emailsSent).toHaveLength(1);
  });
});
