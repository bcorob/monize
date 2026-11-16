import { SystemAlertService } from "./system-alert.service";
import { NotificationService } from "../notification-center/notification.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { getRequestContext, RequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * Identity smoke for system alerts, run against the REAL `withScopedDb` at
 * `RLS_MODE=enforce` (pattern: `src/delegation/rls-context-smoke.spec.ts`).
 *
 * `system-alert.service.spec.ts` mocks `withScopedDb` away, which is right for
 * asserting what the service writes and structurally blind to which identity
 * it writes it under. Every caller here is a cron catch or a bootstrap hook
 * with no request behind it, so the service must seed its own context -- the
 * admin fan-out under a system bypass (the recipient query and each admin's
 * row are cross-user by construction), a per-user alert under that user's own
 * identity. A regression to ambient-context reliance throws under every
 * RLS_MODE; a regression to the wrong identity is what these tests see.
 */
describe("System alerts RLS identity smoke (real withScopedDb)", () => {
  const ADMIN_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const USER_ID = "d1a2b3c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  const BYPASS_SQL = "SELECT set_config('app.bypass_rls', 'on', true)";

  const originalMode = process.env.RLS_MODE;

  interface Seen {
    op: string;
    ctx: RequestContext | undefined;
  }

  let seen: Seen[];
  let manager: Record<string, jest.Mock>;
  let service: SystemAlertService;

  beforeEach(() => {
    process.env.RLS_MODE = "enforce";
    seen = [];
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    // The door reads back the row it inserted; answer that read so the insert
    // is reported as a win rather than as somebody else's row.
    manager.getRepository.mockImplementation(() => ({
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
      ),
    }));
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("set_config")) return [];
      if (text.includes("FROM users u")) {
        seen.push({ op: "adminQuery", ctx: getRequestContext() });
        return [
          {
            id: ADMIN_ID,
            email: "ops@example.com",
            first_name: "Ada",
            email_enabled: true,
          },
        ];
      }
      if (text.includes("INSERT INTO notifications")) {
        seen.push({ op: "insert", ctx: getRequestContext() });
        return [{ id: "row-1" }];
      }
      return [];
    });
    // The real write door, on the same connection: the point of this file is
    // which identity each statement runs under, and the door is where the
    // INSERT now lives.
    const writeDoor = new NotificationService(mocks.dataSource as never);
    service = new SystemAlertService(
      mocks.dataSource as never,
      // SMTP unconfigured: the email leg is covered by the unit spec, and
      // skipping it keeps this file about the two statements that write.
      { getStatus: jest.fn().mockReturnValue({ configured: false }) } as never,
      { translate: jest.fn() } as never,
      // No emailDedupeKey is passed below, so the claim is never consulted.
      { claimOnce: jest.fn().mockResolvedValue(true) } as never,
      writeDoor,
      // The per-user path fans out through dispatch, whose own identity reads
      // have their own suite. Forward `notify` to the write door so this file
      // stays about the ONE statement that writes and the identity it runs
      // under -- the `withUserContext` around `notify` is what seeds it.
      {
        notify: (userId: string, input: unknown) =>
          writeDoor.create(userId, input as never),
      } as never,
    );
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = originalMode;
  });

  /** The set_config statements withScopedDb actually emitted, in order. */
  function gucs(): string[] {
    return manager.query.mock.calls
      .filter(([sql]: [string]) => String(sql).includes("set_config"))
      .map(([sql, params]: [string, string[]]) =>
        params?.length ? `${sql} <- ${params[0]}` : sql,
      );
  }

  it("raiseAdminAlert seeds its own system context: recipient query and fan-out both run under the bypass", async () => {
    // Deliberately no ambient context around the call -- the cron catch that
    // raises a backup alert has none, and the service must not depend on one.
    const result = await service.raiseAdminAlert({
      type: NotificationType.BACKUP_FAILED,
      severity: NotificationSeverity.CRITICAL,
      title: "t",
      message: "m",
      data: { system: true },
      dedupeKey: "BACKUP_FAILED:u:2026-08-30",
    });

    expect(result.created).toBe(1);
    expect(
      seen.map((s) => `${s.op}: ${s.ctx?.system ? "bypass" : "WRONG"}`),
    ).toEqual(["adminQuery: bypass", "insert: bypass"]);
    // Two transactions (the recipient read, then the admin's insert), each
    // announcing the bypass to the database.
    expect(gucs()).toEqual([BYPASS_SQL, BYPASS_SQL]);
  });

  it("raiseUserAlert seeds the affected user's own identity, not a bypass", async () => {
    const result = await service.raiseUserAlert(USER_ID, {
      type: NotificationType.SCHEDULED_POST_FAILED,
      severity: NotificationSeverity.WARNING,
      title: "t",
      message: "m",
      data: { system: true },
      dedupeKey: "SCHEDULED_POST_FAILED:st:2026-08-30",
    });

    expect(result).toEqual({ created: true });
    expect(
      seen.map(
        (s) =>
          `${s.op}: current=${s.ctx?.userId} real=${
            s.ctx?.realUserId ?? s.ctx?.userId
          }`,
      ),
    ).toEqual([`insert: current=${USER_ID} real=${USER_ID}`]);
    expect(gucs()).toEqual([
      `SELECT set_config('app.current_user_id', $1, true) <- ${USER_ID}`,
      `SELECT set_config('app.real_user_id', $1, true) <- ${USER_ID}`,
    ]);
  });
});
