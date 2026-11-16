import { BadRequestException, NotFoundException } from "@nestjs/common";

import {
  NotificationReminderService,
  DEDUPE_BASE_MAX_LENGTH,
} from "./notification-reminder.service";
import { NotificationService } from "./notification.service";
import { Notification } from "./entities/notification.entity";
import { ReminderRepeatMode } from "./entities/notification-reminder.entity";
import {
  MAX_ACTIVE_REMINDERS_PER_USER,
  REMINDER_MIN_INTERVAL_MINUTES,
} from "./notification-reminder.constants";
import * as scopedDb from "../common/db/scoped-db";
import * as withContext from "../common/db/with-context";

jest.mock("../common/db/scoped-db");
jest.mock("../common/db/with-context");

describe("NotificationReminderService", () => {
  let service: NotificationReminderService;
  let notifications: jest.Mocked<Pick<NotificationService, "create">>;
  let sourceRepo: Record<string, jest.Mock>;
  let reminderRepo: Record<string, jest.Mock>;
  let query: jest.Mock;

  beforeEach(() => {
    sourceRepo = { findOne: jest.fn().mockResolvedValue(null) };
    reminderRepo = {
      find: jest.fn().mockResolvedValue([]),
      // Default: no existing active reminder for the source, and well under cap.
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(async (v) => ({
        id: "rem-1",
        createdAt: new Date("2026-09-02T00:00:00Z"),
        lastFiredAt: null,
        fireCount: 0,
        ...v,
      })),
    };
    query = jest.fn().mockResolvedValue([]);
    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === Notification ? sourceRepo : reminderRepo,
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );
    (withContext.withSystemContext as jest.Mock).mockImplementation(
      (fn: () => unknown) => fn(),
    );
    (withContext.withUserContext as jest.Mock).mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );

    notifications = { create: jest.fn().mockResolvedValue({ id: "n-fresh" }) };
    service = new NotificationReminderService(
      {} as ConstructorParameters<typeof NotificationReminderService>[0],
      notifications as unknown as NotificationService,
    );
  });

  const source = {
    id: "src-1",
    userId: "u1",
    type: "BILL_DUE",
    severity: "warning",
    title: "Rent due",
    message: "Rent is due in 3 days",
    data: { budget: "x" },
    target: "/bills",
    dedupeKey: null,
  };

  describe("create", () => {
    it("copies the source's content into the template and schedules one interval out", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      const now = 1_000_000_000_000;
      jest.spyOn(Date, "now").mockReturnValue(now);

      const view = await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });

      // Loaded the caller's own LIVE source (dismissed rows are not eligible).
      expect(sourceRepo.findOne).toHaveBeenCalledWith({
        where: {
          id: "src-1",
          userId: "u1",
          dismissedAt: expect.anything(),
        },
      });
      const saved = reminderRepo.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        userId: "u1",
        sourceNotificationId: "src-1",
        type: "BILL_DUE",
        severity: "warning",
        title: "Rent due",
        message: "Rent is due in 3 days",
        target: "/bills",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });
      // First nag one interval after creation (source already delivered #1).
      expect((saved.nextFireAt as Date).getTime()).toBe(now + 15 * 60_000);
      expect(view.intervalMinutes).toBe(15);
    });

    it("derives dedupe_base from the source dedupe key when it has one", async () => {
      sourceRepo.findOne.mockResolvedValue({
        ...source,
        dedupeKey: "PROVIDER_OUTAGE:yahoo",
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      expect(reminderRepo.save.mock.calls[0][0].dedupeBase).toBe(
        "PROVIDER_OUTAGE:yahoo",
      );
    });

    it("bounds dedupe_base to the column width", async () => {
      sourceRepo.findOne.mockResolvedValue({
        ...source,
        dedupeKey: "x".repeat(200),
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      expect(
        reminderRepo.save.mock.calls[0][0].dedupeBase.length,
      ).toBeLessThanOrEqual(DEDUPE_BASE_MAX_LENGTH);
    });

    it("clamps an interval below the floor UP, never below it", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 2,
      });
      expect(reminderRepo.save.mock.calls[0][0].intervalMinutes).toBe(
        REMINDER_MIN_INTERVAL_MINUTES,
      );
    });

    it("refuses a source that is not the caller's live notification", async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create("u1", {
          sourceNotificationId: "missing",
          repeatMode: ReminderRepeatMode.ONCE,
          intervalMinutes: 15,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reminderRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a reminder on a reminder's own nag (the parent's next fire would dismiss it)", async () => {
      sourceRepo.findOne.mockResolvedValue({
        ...source,
        id: "nag-1",
        data: { billId: "b1", reminderId: "rem-parent" },
      });
      await expect(
        service.create("u1", {
          sourceNotificationId: "nag-1",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reminderRepo.save).not.toHaveBeenCalled();
    });

    it("re-configures the one active reminder instead of adding a parallel nag, bypassing the cap", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      // An active reminder already exists for this source.
      reminderRepo.findOne.mockResolvedValue({
        id: "existing",
        userId: "u1",
        sourceNotificationId: "src-1",
        fireCount: 7,
        stoppedAt: null,
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      const saved = reminderRepo.save.mock.calls[0][0];
      // The same row is updated (not a new one) and its schedule restarts; the
      // fire count is NOT reset -- it is the ordinal in each re-emit's dedupe
      // key, and a reset would replay keys the write door already refuses.
      expect(saved.id).toBe("existing");
      expect(saved.repeatMode).toBe(ReminderRepeatMode.ONCE);
      expect(saved.intervalMinutes).toBe(30);
      expect(saved.fireCount).toBe(7);
      expect(saved.stoppedAt).toBeNull();
      // A re-configure is not a new reminder, so the cap is not consulted.
      expect(reminderRepo.count).not.toHaveBeenCalled();
    });

    it("refuses a genuinely new reminder past the per-user cap", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      reminderRepo.findOne.mockResolvedValue(null); // no existing for this source
      reminderRepo.count.mockResolvedValue(MAX_ACTIVE_REMINDERS_PER_USER);
      await expect(
        service.create("u1", {
          sourceNotificationId: "src-1",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reminderRepo.save).not.toHaveBeenCalled();
    });

    it("recovers from a concurrent unique-index conflict by re-reading the winner", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      // First pass: no existing -> insert -> loses the race (23505 on the index).
      // Second pass: the winner's row is now visible -> update it.
      reminderRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "winner",
        userId: "u1",
        sourceNotificationId: "src-1",
        stoppedAt: null,
      });
      reminderRepo.save
        .mockRejectedValueOnce({
          code: "23505",
          constraint: "idx_notification_reminders_active_source",
        })
        .mockResolvedValueOnce({
          id: "winner",
          createdAt: new Date("2026-09-02T00:00:00Z"),
          nextFireAt: new Date("2026-09-02T00:15:00Z"),
          lastFiredAt: null,
          fireCount: 0,
          sourceNotificationId: "src-1",
          type: "BILL_DUE",
          severity: "warning",
          title: "Rent due",
          message: "Rent is due in 3 days",
          target: "/bills",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        });
      const view = await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });
      expect(view.id).toBe("winner");
      expect(reminderRepo.save).toHaveBeenCalledTimes(2);
      // The retry is only reachable if the failed INSERT was rolled back to a
      // savepoint first: after 23505 PostgreSQL aborts the transaction and the
      // re-read would fail with 25P02. So the choreography is the claim.
      expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
        "SAVEPOINT notification_reminder_upsert",
        "ROLLBACK TO SAVEPOINT notification_reminder_upsert",
      ]);
    });

    it("releases the savepoint when the first attempt goes through", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });
      expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
        "SAVEPOINT notification_reminder_upsert",
        "RELEASE SAVEPOINT notification_reminder_upsert",
      ]);
    });

    it("does not swallow a non-conflict save error", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      reminderRepo.save.mockRejectedValue(new Error("disk full"));
      await expect(
        service.create("u1", {
          sourceNotificationId: "src-1",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        }),
      ).rejects.toThrow("disk full");
      // No rollback-to-savepoint for a foreign error: the whole transaction
      // rolls back, and a retry of an unknown failure would be a guess.
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).startsWith("ROLLBACK TO SAVEPOINT"),
        ),
      ).toBe(false);
    });
  });

  it("returns structured copy facts in the owner-only active list", async () => {
    reminderRepo.find.mockResolvedValue([
      {
        ...source,
        id: "rem-1",
        sourceNotificationId: source.id,
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 60,
        nextFireAt: new Date("2026-09-10T12:00:00Z"),
        createdAt: new Date("2026-09-01T12:00:00Z"),
        lastFiredAt: null,
        fireCount: 0,
      },
    ]);
    const rows = await service.list("u1");
    expect(rows[0].data).toEqual(source.data);
    expect(reminderRepo.find).toHaveBeenCalledWith({
      where: { userId: "u1", stoppedAt: expect.anything() },
      order: { createdAt: "DESC" },
    });
  });

  describe("stop", () => {
    it("reports stopped when a live row was the caller's", async () => {
      query.mockResolvedValue([[{ id: "rem-1" }], 1]);
      expect(await service.stop("u1", "rem-1")).toEqual({ stopped: true });
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain("stopped_at IS NULL");
      expect(params).toEqual(["rem-1", "u1"]);
    });

    it("is idempotent: an already-stopped or foreign id returns stopped:false, never throws", async () => {
      query.mockResolvedValue([[], 0]);
      expect(await service.stop("u1", "rem-1")).toEqual({ stopped: false });
    });
  });
});
