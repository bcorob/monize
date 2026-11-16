import { DataSource } from "typeorm";

import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import {
  AI_REVIEW_EXPIRING_FROM_DAYS,
  AI_REVIEW_EXPIRING_TO_DAYS,
  AiReviewNotificationService,
  buildProposalsExpiringNotification,
  buildProposalsReadyNotification,
} from "./ai-review-notification.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));

const USER_A = "a0a0a0a0-0000-4000-8000-000000000001";
const USER_B = "b0b0b0b0-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-18T07:41:00.000Z");

describe("AiReviewNotificationService", () => {
  let service: AiReviewNotificationService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let dispatch: { notify: jest.Mock };
  /** Rows the expiring fan-out returns. */
  let fanOut: { user_id: string; total: string; earliest?: Date }[];
  /** Users with live proposals, and the per-user [total, added] answer. */
  let users: string[];
  let counts: Record<string, { total: string; added: string }>;

  beforeEach(() => {
    ({ dataSource, manager } = createScopedDbMocks([]));
    fanOut = [];
    users = [];
    counts = {};
    manager.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          sql.includes("COUNT(*) AS total") &&
          sql.includes("FROM ai_review_requests r")
        ) {
          return [
            counts[String((params ?? [])[0])] ?? { total: "0", added: "0" },
          ];
        }
        if (sql.includes("SELECT DISTINCT user_id")) {
          return users.map((user_id) => ({ user_id }));
        }
        return fanOut;
      },
    );
    dispatch = { notify: jest.fn().mockResolvedValue({ id: "n1" }) };
    service = new AiReviewNotificationService(
      dataSource as unknown as DataSource,
      dispatch as unknown as NotificationDispatchService,
    );
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.clearAllMocks());

  describe("notifyReady", () => {
    it("with no previous notice, added is the whole count", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "3", added: "3" } };

      await expect(service.notifyReady(NOW)).resolves.toBe(1);

      expect(dispatch.notify).toHaveBeenCalledTimes(1);
      const [userId, input] = dispatch.notify.mock.calls[0];
      expect(userId).toBe(USER_A);
      expect(input).toMatchObject({
        type: NotificationType.AI_REVIEW_PROPOSALS_READY,
        severity: NotificationSeverity.INFO,
        data: { count: 3, added: 3 },
        target: "/ai-reviews",
        dedupeKey: "air:ready:2026-10-18T07",
      });
      expect(withSystemContext).toHaveBeenCalledTimes(1);
      expect(withUserContext).toHaveBeenCalledWith(
        USER_A,
        expect.any(Function),
      );
    });

    it("notifies the new proposals when an old notice was never dismissed and everything since was approved", async () => {
      // 3 were noticed and approved; the old notice is still there. 2 new
      // proposals are live: count 2, both newer than the notice.
      users = [USER_A];
      counts = { [USER_A]: { total: "2", added: "2" } };

      await expect(service.notifyReady(NOW)).resolves.toBe(1);

      expect(dispatch.notify.mock.calls[0][1].data).toEqual({
        count: 2,
        added: 2,
      });
    });

    it("reports all live proposals as count and only the new ones as added", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "5", added: "2" } };

      await service.notifyReady(NOW);

      expect(dispatch.notify.mock.calls[0][1].data).toEqual({
        count: 5,
        added: 2,
      });
    });

    it("raises nothing when no proposal is newer than the last notice", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "3", added: "0" } };

      await expect(service.notifyReady(NOW)).resolves.toBe(0);

      expect(dispatch.notify).not.toHaveBeenCalled();
    });

    it("raises nothing when nobody has a live proposal", async () => {
      await expect(service.notifyReady(NOW)).resolves.toBe(0);

      expect(dispatch.notify).not.toHaveBeenCalled();
    });

    it("compares with the newest ready notice dismissed or not, by the database clock", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "1", added: "1" } };

      await service.notifyReady(NOW);

      const lookup = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("FROM ai_review_requests r"),
      );
      const sql = String(lookup?.[0]);
      expect(sql).toContain("MAX(n.created_at)");
      expect(sql).not.toContain("dismissed_at");
      expect(sql).toContain("r.updated_at >");
      expect(sql).toContain("'-infinity'::timestamptz");
      expect(sql).toContain("r.status = 'proposed'");
      expect(sql).toContain("r.expires_at > CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/pending|claimed/);
      expect(lookup?.[1]).toEqual([
        USER_A,
        NotificationType.AI_REVIEW_PROPOSALS_READY,
      ]);
    });

    it("lists only users with live proposed requests in the fan-out", async () => {
      await service.notifyReady(NOW);

      const sql = String(manager.query.mock.calls[0][0]);
      expect(sql).toContain("status = 'proposed'");
      expect(sql).toContain("expires_at > CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/pending|claimed/);
    });

    it("keys the notice by UTC hour so a later hour can notify again", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "1", added: "1" } };

      await service.notifyReady(new Date("2026-10-18T07:20:00.000Z"));
      await service.notifyReady(new Date("2026-10-18T13:20:00.000Z"));

      expect(
        dispatch.notify.mock.calls.map(([, input]) => input.dedupeKey),
      ).toEqual(["air:ready:2026-10-18T07", "air:ready:2026-10-18T13"]);
    });

    it("sends nothing when the insert lost to another replica", async () => {
      users = [USER_A];
      counts = { [USER_A]: { total: "2", added: "2" } };
      dispatch.notify.mockResolvedValue(null);

      await expect(service.notifyReady(NOW)).resolves.toBe(0);
    });

    it("isolates one user's failure from the others", async () => {
      users = [USER_A, USER_B];
      counts = {
        [USER_A]: { total: "2", added: "2" },
        [USER_B]: { total: "4", added: "4" },
      };
      dispatch.notify.mockRejectedValueOnce(new Error("push down"));

      await expect(service.notifyReady(NOW)).resolves.toBe(1);

      expect(dispatch.notify).toHaveBeenCalledTimes(2);
      expect(dispatch.notify.mock.calls[1][0]).toBe(USER_B);
      expect(service["logger"].error).toHaveBeenCalledWith(
        expect.stringContaining(USER_A),
      );
    });

    it("never throws when the fan-out read fails", async () => {
      manager.query.mockRejectedValue(new Error("db down"));

      await expect(service.notifyReady(NOW)).resolves.toBe(0);

      expect(service["logger"].warn).toHaveBeenCalled();
    });
  });

  describe("notifyExpiring", () => {
    it("writes one notice per user with the group's count and earliest expiry", async () => {
      const earliest = new Date("2026-10-21T05:00:00.000Z");
      fanOut = [
        { user_id: USER_A, total: "2", earliest },
        { user_id: USER_B, total: "1", earliest },
      ];

      await expect(service.notifyExpiring(NOW)).resolves.toBe(2);

      expect(dispatch.notify).toHaveBeenCalledTimes(2);
      expect(dispatch.notify.mock.calls[0][0]).toBe(USER_A);
      expect(dispatch.notify.mock.calls[0][1]).toMatchObject({
        type: NotificationType.AI_REVIEW_PROPOSALS_EXPIRING,
        severity: NotificationSeverity.WARNING,
        data: { count: 2, earliestExpiresAt: "2026-10-21T05:00:00.000Z" },
        target: "/ai-reviews",
        dedupeKey: "air:exp:2026-10-18",
      });
    });

    it("reads the window [now + 2 days, now + 3 days) of proposed requests in the database clock", async () => {
      await service.notifyExpiring(NOW);

      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toContain("status = 'proposed'");
      // Inclusive lower bound (2 days 23 hours ahead counts; 3 days ahead and
      // 1 day 23 hours ahead do not), exclusive upper bound.
      expect(String(sql)).toContain(
        "expires_at >= CURRENT_TIMESTAMP + make_interval(days => $1)",
      );
      expect(String(sql)).toContain(
        "expires_at < CURRENT_TIMESTAMP + make_interval(days => $2)",
      );
      expect(params).toEqual([2, 3]);
      expect([
        AI_REVIEW_EXPIRING_FROM_DAYS,
        AI_REVIEW_EXPIRING_TO_DAYS,
      ]).toEqual([2, 3]);
    });

    it("sends nothing when another replica already wrote today's notice", async () => {
      fanOut = [{ user_id: USER_A, total: "1", earliest: new Date(NOW) }];
      dispatch.notify.mockResolvedValue(null);

      await expect(service.notifyExpiring(NOW)).resolves.toBe(0);
    });

    it("isolates one user's failure from the others", async () => {
      const earliest = new Date("2026-10-21T05:00:00.000Z");
      fanOut = [
        { user_id: USER_A, total: "2", earliest },
        { user_id: USER_B, total: "1", earliest },
      ];
      dispatch.notify.mockRejectedValueOnce(new Error("push down"));

      await expect(service.notifyExpiring(NOW)).resolves.toBe(1);

      expect(dispatch.notify).toHaveBeenCalledTimes(2);
    });

    it("never throws when the fan-out read fails", async () => {
      manager.query.mockRejectedValue(new Error("db down"));

      await expect(service.notifyExpiring(NOW)).resolves.toBe(0);
    });
  });

  describe("copy", () => {
    const secret = {
      instruction: "Pay Secret Payee 99.99 from the email",
      payee: "Secret Payee",
    };

    it("holds counts and the date only", () => {
      const notices = [
        buildProposalsReadyNotification(5, 2, "2026-10-18T07"),
        buildProposalsExpiringNotification(
          2,
          new Date("2026-10-21T05:00:00.000Z"),
          "2026-10-18",
        ),
      ];
      for (const notice of notices) {
        const text = JSON.stringify(notice);
        expect(text).not.toContain(secret.payee);
        expect(text).not.toMatch(/instruction|payee|amount|99\.99/i);
        expect(notice.target).toBe("/ai-reviews");
        expect(notice.dedupeKey).toMatch(/^air:(ready|exp):2026-10-18/);
      }
      expect(Object.keys(notices[0].data ?? {})).toEqual(["count", "added"]);
      expect(Object.keys(notices[1].data ?? {})).toEqual([
        "count",
        "earliestExpiresAt",
      ]);
      expect(notices[1].message).toContain("2026-10-21");
    });
  });
});
