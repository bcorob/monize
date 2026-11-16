import { Logger } from "@nestjs/common";
import {
  DEDUPE_KEY_MAX_LENGTH,
  SystemAlertService,
  SystemAlertInput,
} from "./system-alert.service";
import {
  Notification,
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { NotificationService } from "../notification-center/notification.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (_userId: string, fn: () => unknown) => fn(),
}));

/** One admin row as queryAdminRecipients' SQL returns it. */
function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email: "ops@example.com",
    first_name: "Ada",
    email_enabled: true,
    ...overrides,
  };
}

function input(overrides: Partial<SystemAlertInput> = {}): SystemAlertInput {
  return {
    type: NotificationType.BACKUP_FAILED,
    severity: NotificationSeverity.CRITICAL,
    title: "Automatic backup failed",
    message: "The automatic backup for x failed: boom",
    data: { system: true },
    dedupeKey: "BACKUP_FAILED:user-1:2026-08-30",
    ...overrides,
  };
}

describe("SystemAlertService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let emailService: { getStatus: jest.Mock; sendMail: jest.Mock };
  let jobClaims: { claimOnce: jest.Mock };
  /**
   * The dispatch seam's `notify`, recorded AND forwarded to the real write door.
   * Recording is what makes "the row travels through dispatch" a tested fact:
   * a double that only forwarded was indistinguishable from the door itself, so
   * reverting insertAlert to `notifications.create` left every test green.
   */
  let dispatchNotify: jest.Mock;
  let service: SystemAlertService;

  /**
   * Route the three statements the service issues. `insertResults` answers the
   * guarded INSERTs in order (an empty array is the conflict loser); admins is
   * what the recipient query returns.
   */
  function route(data: {
    admins?: unknown[];
    insertResults?: Array<Array<{ id: string }>>;
    adminQueryError?: Error;
  }): void {
    const inserts = [...(data.insertResults ?? [[{ id: "alert-row-1" }]])];
    manager.query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("FROM users u")) {
        if (data.adminQueryError) return Promise.reject(data.adminQueryError);
        return Promise.resolve(data.admins ?? [adminRow()]);
      }
      if (text.includes("INSERT INTO notifications")) {
        // The pg driver returns bare rows for INSERT (never the
        // [rows, rowCount] tuple) -- see common/db/query-result.ts.
        return Promise.resolve(
          inserts.length > 0 ? inserts.shift() : [{ id: "alert-row-n" }],
        );
      }
      if (text.includes("SET is_email_sent")) {
        return Promise.resolve([[], 1]);
      }
      return Promise.resolve([]);
    });
    // Entity-aware because the write door reads the row it just inserted back
    // as authoritative state: answering every findOne with a user preference
    // would hand it a row with no id, which it correctly reads as "somebody
    // else holds this notification".
    manager.getRepository.mockImplementation((entity: unknown) =>
      entity === Notification
        ? {
            findOne: jest.fn(({ where }: { where: { id: string } }) =>
              Promise.resolve({ id: where.id }),
            ),
          }
        : { findOne: jest.fn().mockResolvedValue({ language: "en" }) },
    );
  }

  const insertStatements = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO notifications"),
    );

  /**
   * One insert's parameters keyed by the column the statement names, read out of
   * the statement itself.
   *
   * By position these assertions pinned a parameter index, which is a fact about
   * the writer's column order and not about the row: moving the INSERT behind
   * one door renumbered every one of them, and an index that still exists points
   * at the wrong value rather than failing.
   */
  const insertedRow = (index = 0): Record<string, unknown> => {
    const [sql, params] = insertStatements()[index];
    const columns = /INSERT INTO notifications\s*\(([^)]*)\)/.exec(String(sql));
    if (!columns) throw new Error(`no column list in: ${String(sql)}`);
    const names = columns[1].split(",").map((name) => name.trim());
    return Object.fromEntries(
      names.map((name, i) => [name, (params as unknown[])[i]]),
    );
  };

  const emailSentUpdates = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET is_email_sent"),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks([
      [UserPreference, { findOne: jest.fn().mockResolvedValue(null) }],
    ]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    jobClaims = { claimOnce: jest.fn().mockResolvedValue(true) };
    // The real door, on the same mocked connection: what these tests are about is
    // the SQL that lands and which recipient emails, and a double standing in for
    // the writer would assert the call instead of the row.
    const writeDoor = new NotificationService(dataSource as never);
    // Both the admin fan-out (insertAlert) and the per-user path go through the
    // dispatch seam. Forward `notify` to the real write door so the guarded
    // insert still lands (and `created` still reflects the ON CONFLICT result)
    // without pulling the push / email fan-out into these SQL-shape tests -- the
    // fan-out has its own suite (`notification-dispatch.service.spec.ts`).
    dispatchNotify = jest.fn((userId: string, input: unknown) =>
      writeDoor.create(userId, input as never),
    );
    service = new SystemAlertService(
      dataSource as never,
      emailService as never,
      {
        translate: (_key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? _key,
      } as never,
      jobClaims as never,
      writeDoor,
      { notify: dispatchNotify } as never,
    );
  });

  it("localizes each administrator's email and subject separately", async () => {
    route({
      admins: [
        adminRow(),
        adminRow({ id: "admin-2", email: "second@example.com" }),
      ],
    });
    const original = manager.getRepository.getMockImplementation()!;
    manager.getRepository.mockImplementation((entity) =>
      entity === UserPreference
        ? {
            findOne: jest.fn(({ where }: { where: { userId: string } }) =>
              Promise.resolve({
                language: where.userId === "admin-1" ? "pl" : "de",
              }),
            ),
          }
        : original(entity),
    );
    jest
      .spyOn(service["i18n"], "translate")
      .mockImplementation((key, options) => {
        if (key === "emails.notificationCopy.system.backupFailed.title")
          return `${options?.lang}: backup`;
        if (key === "emails.notificationCopy.system.backupFailed.message")
          return `${options?.lang}: ${(options?.args as Record<string, unknown>)?.error}`;
        return options?.defaultValue ?? key;
      });
    await service.raiseAdminAlert(
      input({
        data: {
          system: true,
          affectedUserEmail: "owner@example.com",
          error: "ENOSPC <disk>",
        },
      }),
    );
    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    for (const [index, lang] of ["pl", "de"].entries()) {
      const [, subject, html] = emailService.sendMail.mock.calls[index];
      expect(subject).toContain(`${lang}: backup`);
      expect(html).toContain(`${lang}: ENOSPC &lt;disk&gt;`);
      expect(html).not.toContain("Automatic backup failed");
    }
  });

  describe("fan-out", () => {
    it("writes one guarded insert per active admin, carrying the dedupe key", async () => {
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
      });
      const result = await service.raiseAdminAlert(input());

      expect(result.created).toBe(2);
      const inserts = insertStatements();
      expect(inserts).toHaveLength(2);
      for (const [sql] of inserts) {
        // One `ON CONFLICT DO NOTHING` covers every unique index on the table,
        // so it arbitrates the dedupe key without naming it: the loser gets no
        // row back and therefore sends nothing.
        expect(String(sql)).toContain("ON CONFLICT DO NOTHING");
        expect(String(sql)).toContain("RETURNING id");
      }
      for (const i of [0, 1]) {
        expect(insertedRow(i).dedupe_key).toBe(
          "BACKUP_FAILED:user-1:2026-08-30",
        );
      }
      expect([insertedRow(0).user_id, insertedRow(1).user_id]).toEqual([
        "admin-1",
        "admin-2",
      ]);
    });

    it("raises every admin's row THROUGH the dispatch seam, so SYSTEM push can reach them", async () => {
      // The row shape is the door's; what this proves is the PATH. An admin who
      // turned SYSTEM push on receives the alert on their device only because
      // insertAlert asks dispatch, not the door -- and a double that merely
      // forwarded could not tell the two apart.
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
      });
      const alert = input();
      await service.raiseAdminAlert(alert);

      expect(dispatchNotify).toHaveBeenCalledTimes(2);
      expect(dispatchNotify.mock.calls.map((call) => call[0])).toEqual([
        "admin-1",
        "admin-2",
      ]);
      expect(dispatchNotify.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          type: alert.type,
          severity: alert.severity,
          dedupeKey: alert.dedupeKey,
        }),
      );
    });

    it("emails only the insert winners: a conflict loser's recipient gets nothing", async () => {
      // Replica race: this replica wins admin-1's row and loses admin-2's.
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
        insertResults: [[{ id: "row-1" }], []],
      });
      const result = await service.raiseAdminAlert(input());

      expect(result).toEqual({ created: 1, emailed: 1 });
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "ops@example.com",
        expect.any(String),
        expect.any(String),
      );
      expect(emailSentUpdates()).toHaveLength(1);
      // The row AND its owner: the flag update carries a tenant predicate, so
      // an id from one admin's fan-out cannot reach another's row.
      expect(emailSentUpdates()[0][1]).toEqual(["row-1", "admin-1"]);
    });

    it("gives an admin with email disabled the row but no mail", async () => {
      route({
        admins: [
          adminRow({ id: "admin-quiet", email: "q@e.f", email_enabled: false }),
        ],
      });
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 1, emailed: 0 });
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("one recipient's failure costs only that recipient", async () => {
      route({
        admins: [
          adminRow({ id: "admin-bad", email: "bad@e.f" }),
          adminRow({ id: "admin-good", email: "good@e.f" }),
        ],
      });
      emailService.sendMail.mockRejectedValueOnce(new Error("550 rejected"));
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 2, emailed: 1 });
      // The failed send never marks its row as emailed.
      expect(emailSentUpdates()).toHaveLength(1);
    });

    it("warns once, not once per raise, when there is no administrator", async () => {
      route({ admins: [] });
      const warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      try {
        for (let i = 0; i < 4; i++) await service.raiseAdminAlert(input());
        const lines = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((text) => text.includes("no active administrator"));
        expect(lines).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("email gating", () => {
    it("defaults to email for critical and warning, none for info and success", async () => {
      for (const [severity, expected] of [
        [NotificationSeverity.CRITICAL, 1],
        [NotificationSeverity.WARNING, 1],
        [NotificationSeverity.INFO, 0],
        [NotificationSeverity.SUCCESS, 0],
      ] as const) {
        emailService.sendMail.mockClear();
        route({});
        await service.raiseAdminAlert(input({ severity }));
        expect(emailService.sendMail).toHaveBeenCalledTimes(expected);
      }
    });

    it("honors an explicit email: false on a critical alert", async () => {
      route({});
      await service.raiseAdminAlert(input({ email: false }));
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("never emails SMTP_FAILURE, even when the caller asks for it", async () => {
      // The report that email is broken cannot travel by email; an attempt
      // would land in the very failure snapshot it was raised from.
      route({});
      await service.raiseAdminAlert(
        input({
          type: NotificationType.SMTP_FAILURE,
          severity: NotificationSeverity.CRITICAL,
          email: true,
          dedupeKey: "SMTP_FAILURE:2026-08-30",
        }),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips the send, keeping the row, when SMTP is unconfigured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      route({});
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 1, emailed: 0 });
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe("raiseUserAlert", () => {
    it("writes one row for the affected user and sends no email", async () => {
      route({});
      const result = await service.raiseUserAlert("user-9", {
        type: NotificationType.SCHEDULED_POST_FAILED,
        severity: NotificationSeverity.WARNING,
        title: "Rent could not be posted",
        message: "It failed",
        data: { system: true, scheduledId: "st-1" },
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-08-30",
      });
      expect(result).toEqual({ created: true });
      const inserts = insertStatements();
      expect(inserts).toHaveLength(1);
      expect(inserts[0][1][0]).toBe("user-9");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("reports created: false for the dedupe loser", async () => {
      route({ insertResults: [[]] });
      const result = await service.raiseUserAlert("user-9", {
        type: NotificationType.SCHEDULED_POST_FAILED,
        severity: NotificationSeverity.WARNING,
        title: "t",
        message: "m",
        data: {},
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-08-30",
      });
      expect(result).toEqual({ created: false });
    });
  });

  describe("never throws", () => {
    it("swallows a recipient-query failure and reports zero", async () => {
      route({ adminQueryError: new Error("connection terminated") });
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(service.raiseAdminAlert(input())).resolves.toEqual({
          created: 0,
          emailed: 0,
        });
      } finally {
        error.mockRestore();
      }
    });

    it("swallows an insert failure on the user path", async () => {
      manager.query.mockRejectedValue(new Error("deadlock detected"));
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(
          service.raiseUserAlert("user-9", {
            type: NotificationType.SCHEDULED_POST_FAILED,
            severity: NotificationSeverity.WARNING,
            title: "t",
            message: "m",
            data: {},
            dedupeKey: "k",
          }),
        ).resolves.toEqual({ created: false });
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("bounds", () => {
    it("every NotificationType member fits the alert_type VARCHAR(30) column", () => {
      // A longer member would not fail loudly: PostgreSQL raises 22001 at
      // insert time, which the never-throws contract would swallow, so the
      // alert would silently never exist. Guard the enum instead.
      for (const member of Object.values(NotificationType)) {
        expect(member.length).toBeLessThanOrEqual(30);
      }
    });

    it("truncates a title the VARCHAR(255) column would reject", async () => {
      // Producers interpolate names they do not control. PostgreSQL raises
      // 22001 on an over-long title, the never-throws catch swallows it, and
      // the alert silently never exists -- for SCHEDULED_POST_FAILED that
      // means the user is never told their money did not move.
      route({});
      const long = `${"N".repeat(400)} could not be posted`;
      await service.raiseAdminAlert(input({ title: long }));

      const title = insertedRow().title;
      expect(title).toHaveLength(255);
      expect(String(title).endsWith("\u2026")).toBe(true);
    });

    it("leaves a title within the column alone", async () => {
      route({});
      await service.raiseAdminAlert(
        input({ title: "Automatic backup failed" }),
      );
      expect(insertedRow().title).toBe("Automatic backup failed");
    });

    it("truncates an oversized dedupe key deterministically rather than throwing", async () => {
      route({});
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await service.raiseAdminAlert(
          input({ dedupeKey: "K".repeat(DEDUPE_KEY_MAX_LENGTH + 40) }),
        );
      } finally {
        error.mockRestore();
      }
      expect(insertedRow().dedupe_key).toHaveLength(DEDUPE_KEY_MAX_LENGTH);
    });
  });

  describe("emailDedupeKey (several same-cause alerts, one message)", () => {
    it("emails only the claim winner, while every row is still written", async () => {
      // One broken volume raises one BACKUP_FAILED per affected user. The
      // rows must stay granular -- an administrator has to know WHICH users
      // lost a backup -- but a sixty-user install must not send sixty
      // identical emails.
      route({});
      jobClaims.claimOnce
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      for (const user of ["u-1", "u-2", "u-3"]) {
        await service.raiseAdminAlert(
          input({
            dedupeKey: `BACKUP_FAILED:${user}:2026-08-30`,
            emailDedupeKey: "BACKUP_FAILED:2026-08-30",
          }),
        );
      }

      expect(insertStatements()).toHaveLength(3);
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(jobClaims.claimOnce).toHaveBeenCalledWith(
        "system_alert_email",
        "admin-1",
        "BACKUP_FAILED:2026-08-30",
      );
    });

    it("claims per administrator, so each one is told once", async () => {
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
      });
      await service.raiseAdminAlert(
        input({ emailDedupeKey: "BACKUP_FAILED:2026-08-30" }),
      );
      expect(jobClaims.claimOnce.mock.calls.map((call) => call[1])).toEqual([
        "admin-1",
        "admin-2",
      ]);
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    });

    it("does not claim at all when the caller asked for no email collapsing", async () => {
      route({});
      await service.raiseAdminAlert(input());
      expect(jobClaims.claimOnce).not.toHaveBeenCalled();
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it("sends rather than loses the alert when the claim itself fails", async () => {
      route({});
      jobClaims.claimOnce.mockRejectedValue(new Error("connection terminated"));
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await service.raiseAdminAlert(
          input({ emailDedupeKey: "BACKUP_FAILED:2026-08-30" }),
        );
      } finally {
        error.mockRestore();
      }
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });
  });
});
