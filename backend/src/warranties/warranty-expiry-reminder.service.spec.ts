import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRequestContext } from "../common/request-context";
import {
  type Notification,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { WarrantyExpiryReminderService } from "./warranty-expiry-reminder.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_USER_ID = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const WARRANTY_ID = "3d4e5f60-7182-4c9d-8e0f-2a3b4c5d6e7f";
const OTHER_WARRANTY = "4e5f6071-8293-4d0e-9f1a-3b4c5d6e7f80";

interface Candidate {
  id: string;
  user_id: string;
  name: string;
  expires_on: string;
}

/** Example 3: created 2026-10-21, expiring 2026-11-10 (20 days). */
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: WARRANTY_ID,
  user_id: USER_ID,
  name: "Dishwasher",
  expires_on: "2026-11-10",
  ...over,
});

/** The daily run, 06:17 UTC. */
const runAt = (day: string) => new Date(`${day}T06:17:00.000Z`);

describe("WarrantyExpiryReminderService", () => {
  const { manager, dataSource } = createScopedDbMocks();
  const dispatch = {
    notify: jest.fn<
      Promise<Notification | null>,
      [string, CreateNotificationInput]
    >(),
  };
  let service: WarrantyExpiryReminderService;

  let warranties: Candidate[];
  /** user id -> [timezone, last_client_timezone] */
  let zones: Record<string, [string | null, string | null]>;

  beforeEach(async () => {
    jest.clearAllMocks();
    warranties = [candidate()];
    zones = { [USER_ID]: ["UTC", null], [OTHER_USER_ID]: ["UTC", null] };
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM warranties")) return warranties;
      if (text.includes("FROM users u")) {
        return Object.entries(zones).map(([user_id, [timezone, cached]]) => ({
          user_id,
          timezone,
          last_client_timezone: cached,
        }));
      }
      return [];
    });
    dispatch.notify.mockResolvedValue({ id: "n1" } as Notification);
    const module = await Test.createTestingModule({
      providers: [
        WarrantyExpiryReminderService,
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(WarrantyExpiryReminderService);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  /** What the run wrote, as [user, type, dedupe key]. */
  const written = () =>
    dispatch.notify.mock.calls.map((call) => [
      call[0],
      call[1].type,
      call[1].dedupeKey,
    ]);

  const key = (mark: number, expiresOn = "2026-11-10") =>
    `wty:exp:${WARRANTY_ID}:${expiresOn}:${mark}`;

  describe("the schedule", () => {
    it("is a daily cron at 06:17 UTC on run()", () => {
      const source = readFileSync(
        join(__dirname, "warranty-expiry-reminder.service.ts"),
        "utf8",
      );
      expect(source).toContain(
        '@Cron("17 6 * * *", { timeZone: "UTC" })\n  async run()',
      );
    });

    it("reads unarchived, non-lifetime warranties expiring between the UTC yesterday and 31 days ahead", async () => {
      await service.evaluate(runAt("2026-10-21"));
      const call = manager.query.mock.calls.find((c) =>
        String(c[0]).includes("FROM warranties"),
      ) as [string, [string, string]];
      expect(String(call[0])).toContain("archived_at IS NULL");
      expect(String(call[0])).toContain("is_lifetime = false");
      expect(String(call[0])).toContain(
        "expires_on BETWEEN $1::date AND $2::date",
      );
      expect(String(call[0])).toContain("TO_CHAR(expires_on, 'YYYY-MM-DD')");
      expect(call[1]).toEqual(["2026-10-20", "2026-11-21"]);
    });

    it("runs through the cron handler with the real clock and never throws", async () => {
      manager.query.mockRejectedValue(new Error("db down"));
      await expect(service.run()).resolves.toBeUndefined();
      expect(service["logger"].error).toHaveBeenCalledTimes(1);
    });

    it("logs what this replica wrote", async () => {
      warranties = [];
      await service.run();
      // Nothing written, no line.
      expect(service["logger"].log).not.toHaveBeenCalled();
      warranties = [
        candidate({ expires_on: new Date().toISOString().slice(0, 10) }),
      ];
      await service.run();
      expect(service["logger"].log).toHaveBeenCalledWith(
        "Warranty expiry reminders: 1 written by this replica",
      );
    });
  });

  describe("truth table B, day by day", () => {
    // Expires 2026-11-10, the user counting in UTC.
    it.each([
      ["2026-09-26", null], // 45 days: above 30
      ["2026-10-10", null], // 31 days: nothing yet
      ["2026-10-11", 30], // 30 days
      ["2026-10-21", 30], // 20 days (the key already exists after the first tick)
      ["2026-11-02", 30], // 8 days
      ["2026-11-03", 7], // 7 days
      ["2026-11-09", 7], // 1 day
      ["2026-11-10", 0], // expires today
      ["2026-11-11", null], // -1: nothing after the day of expiry
    ] as const)("on %s the mark owed is %s", async (day, mark) => {
      await service.evaluate(runAt(day));
      const expected =
        mark === null
          ? []
          : [
              [
                USER_ID,
                mark === 0
                  ? NotificationType.WARRANTY_EXPIRES_TODAY
                  : NotificationType.WARRANTY_EXPIRING,
                key(mark),
              ],
            ];
      expect(written()).toEqual(expected);
    });

    it("example 3: created with 20 days left, fires :30 on its first tick, then :7, then :0", async () => {
      for (const day of ["2026-10-21", "2026-11-03", "2026-11-10"]) {
        await service.evaluate(runAt(day));
      }
      expect(written()).toEqual([
        [USER_ID, NotificationType.WARRANTY_EXPIRING, key(30)],
        [USER_ID, NotificationType.WARRANTY_EXPIRING, key(7)],
        [USER_ID, NotificationType.WARRANTY_EXPIRES_TODAY, key(0)],
      ]);
    });

    it("fires the same key on every day of one mark, which the dedupe index turns into one row", async () => {
      for (const day of ["2026-11-04", "2026-11-05", "2026-11-06"]) {
        await service.evaluate(runAt(day));
      }
      expect(new Set(written().map((w) => w[2]))).toEqual(new Set([key(7)]));
    });

    it("fires only the latest mark after a missed run, not the skipped ones", async () => {
      await service.evaluate(runAt("2026-11-10"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.WARRANTY_EXPIRES_TODAY, key(0)],
      ]);
    });

    it("example 4: a moved expires_on forms new keys", async () => {
      await service.evaluate(runAt("2026-11-03"));
      warranties = [candidate({ expires_on: "2027-11-10" })];
      await service.evaluate(runAt("2027-10-11"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.WARRANTY_EXPIRING, key(7)],
        [USER_ID, NotificationType.WARRANTY_EXPIRING, key(30, "2027-11-10")],
      ]);
    });

    it("carries the facts, the target and the reader's today", async () => {
      await service.evaluate(runAt("2026-11-05"));
      expect(dispatch.notify.mock.calls[0][1]).toMatchObject({
        target: `/warranties/${WARRANTY_ID}`,
        periodStart: "2026-11-05",
        data: {
          warrantyId: WARRANTY_ID,
          name: "Dishwasher",
          expiresOn: "2026-11-10",
          threshold: 7,
          daysLeft: 5,
        },
      });
    });

    it("counts only what this replica wrote: a lost insert is the other replica's", async () => {
      dispatch.notify.mockResolvedValue(null);
      const tally = await service.evaluate(runAt("2026-11-05"));
      expect(dispatch.notify).toHaveBeenCalledTimes(1);
      expect(tally).toEqual({ written: 0 });
    });
  });

  describe("days are counted in the user's timezone", () => {
    // 06:17 UTC is 20:17 the evening before in Honolulu (UTC-10).
    it("uses the stored timezone: a zone still on the day before is a day further away", async () => {
      zones[USER_ID] = ["Pacific/Honolulu", null];
      await service.evaluate(runAt("2026-11-03"));
      // Honolulu's today is 2026-11-02: 8 days, still the 30 mark.
      expect(written()).toEqual([
        [USER_ID, NotificationType.WARRANTY_EXPIRING, key(30)],
      ]);
      expect(dispatch.notify.mock.calls[0][1].periodStart).toBe("2026-11-02");
    });

    it("says expires today on the user's own day of expiry", async () => {
      // 23:30 UTC on the 9th is already the 10th in Tokyo (UTC+9).
      zones[USER_ID] = ["Asia/Tokyo", null];
      await service.evaluate(new Date("2026-11-09T23:30:00.000Z"));
      expect(written()).toEqual([
        [USER_ID, NotificationType.WARRANTY_EXPIRES_TODAY, key(0)],
      ]);
    });

    it("falls back to the last seen client zone", async () => {
      zones[USER_ID] = ["browser", "Pacific/Honolulu"];
      await service.evaluate(runAt("2026-11-03"));
      expect(written()[0][2]).toBe(key(30));
    });

    it("counts in UTC rather than skipping when the stored zone does not resolve", async () => {
      zones[USER_ID] = ["Mars/Olympus", null];
      await service.evaluate(runAt("2026-11-03"));
      expect(written()[0][2]).toBe(key(7));
    });
  });

  describe("identity and isolation", () => {
    it("reads the candidates under the system context and writes each reminder under its owner's identity", async () => {
      warranties = [
        candidate(),
        candidate({ id: OTHER_WARRANTY, user_id: OTHER_USER_ID }),
      ];
      const reads: Array<boolean | undefined> = [];
      manager.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        reads.push(getRequestContext()?.system);
        if (text.includes("FROM warranties")) return warranties;
        return [];
      });
      const seen: Array<[string, string | undefined]> = [];
      dispatch.notify.mockImplementation(async (userId: string) => {
        seen.push([userId, getRequestContext()?.userId]);
        return { id: "n" } as Notification;
      });
      await service.evaluate(runAt("2026-11-05"));
      expect(reads.every((system) => system === true)).toBe(true);
      expect(seen).toEqual([
        [USER_ID, USER_ID],
        [OTHER_USER_ID, OTHER_USER_ID],
      ]);
    });

    it("goes on after one warranty fails, and to the next user", async () => {
      warranties = [
        candidate(),
        candidate({ id: OTHER_WARRANTY }),
        candidate({
          id: "5f607182-93a4-4e1f-8a2b-4c5d6e7f8091",
          user_id: OTHER_USER_ID,
        }),
      ];
      dispatch.notify.mockRejectedValueOnce(new Error("first fails"));
      const tally = await service.evaluate(runAt("2026-11-05"));
      expect(dispatch.notify).toHaveBeenCalledTimes(3);
      expect(tally).toEqual({ written: 2 });
      expect(service["logger"].error).toHaveBeenCalledTimes(1);
    });

    it("goes on to the next user when one user's whole pass fails", async () => {
      // An id `withUserContext` refuses fails the whole of that user's pass.
      warranties = [
        candidate({ user_id: "not-a-uuid" }),
        candidate({ id: OTHER_WARRANTY, user_id: OTHER_USER_ID }),
      ];
      const tally = await service.evaluate(runAt("2026-11-05"));
      expect(written()).toEqual([
        [
          OTHER_USER_ID,
          NotificationType.WARRANTY_EXPIRING,
          `wty:exp:${OTHER_WARRANTY}:2026-11-10:7`,
        ],
      ]);
      expect(tally).toEqual({ written: 1 });
      expect(service["logger"].error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Warranty reminders failed for user not-a-uuid",
        ),
      );
    });

    it("writes nothing when no warranty is near its expiry", async () => {
      warranties = [];
      await expect(service.evaluate(runAt("2026-11-05"))).resolves.toEqual({
        written: 0,
      });
      expect(dispatch.notify).not.toHaveBeenCalled();
    });
  });
});
