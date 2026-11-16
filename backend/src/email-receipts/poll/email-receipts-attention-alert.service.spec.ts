import { Logger } from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import {
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  notificationCategoryOf,
} from "../../notification-center/entities/notification.entity";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  buildEmailReceiptsAttentionNotification,
  EmailReceiptsAttentionAlertService,
} from "./email-receipts-attention-alert.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";

function setup(
  counts: Array<{ status: string; total: string }>,
  previous: Array<{ data: Record<string, unknown> | null }> = [],
) {
  const { manager, dataSource } = createScopedDbMocks();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return sql.includes("FROM email_receipts") ? counts : previous;
  });
  const dispatch = {
    notify: jest.fn(async () => ({ id: "n-1" })),
  } as unknown as jest.Mocked<NotificationDispatchService>;
  const service = new EmailReceiptsAttentionAlertService(
    dataSource as never,
    dispatch,
  );
  return { service, dispatch, queries };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe("buildEmailReceiptsAttentionNotification", () => {
  it("carries both counts, the hub link, and a dedupe key made of the pair", () => {
    const input = buildEmailReceiptsAttentionNotification({
      noParser: 3,
      parseFailed: 2,
    });
    expect(input).toMatchObject({
      type: NotificationType.EMAIL_RECEIPTS_ATTENTION,
      severity: NotificationSeverity.INFO,
      data: { noParser: 3, parseFailed: 2 },
      target: "/email-receipts?tab=emails",
      dedupeKey: "email-receipts:3:2",
    });
    expect(input.message).toContain("3");
    expect(input.message).toContain("2");
  });

  it("is filed under its own category", () => {
    expect(
      notificationCategoryOf(NotificationType.EMAIL_RECEIPTS_ATTENTION),
    ).toBe(NotificationCategory.EMAIL_RECEIPTS);
  });
});

describe("EmailReceiptsAttentionAlertService.evaluate", () => {
  it("counts only the two statuses, parameterized by the owner", async () => {
    const h = setup([]);
    await h.service.evaluate(USER);
    const count = h.queries.find((q) => q.sql.includes("FROM email_receipts"))!;
    expect(count.params).toEqual([USER]);
    expect(count.sql).toContain("'no_parser', 'parse_failed'");
    expect(count.sql).not.toMatch(/unmatched|ambiguous/);
  });

  it("raises nothing when both groups are empty", async () => {
    const h = setup([]);
    expect(await h.service.evaluate(USER)).toBe(false);
    expect(h.dispatch.notify).not.toHaveBeenCalled();
  });

  it("raises one notification with both groups' counts", async () => {
    const h = setup([
      { status: "no_parser", total: "4" },
      { status: "parse_failed", total: "1" },
    ]);
    expect(await h.service.evaluate(USER)).toBe(true);
    expect(h.dispatch.notify).toHaveBeenCalledTimes(1);
    expect(h.dispatch.notify).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        data: { noParser: 4, parseFailed: 1 },
        dedupeKey: "email-receipts:4:1",
      }),
      { fanOut: "detached" },
    );
  });

  it("raises when only one group is non-zero", async () => {
    const h = setup([{ status: "parse_failed", total: "2" }]);
    expect(await h.service.evaluate(USER)).toBe(true);
    expect(h.dispatch.notify).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ data: { noParser: 0, parseFailed: 2 } }),
      expect.anything(),
    );
  });

  it("does not repeat the same counts", async () => {
    const h = setup(
      [{ status: "no_parser", total: "3" }],
      [{ data: { noParser: 3, parseFailed: 0 } }],
    );
    expect(await h.service.evaluate(USER)).toBe(false);
    expect(h.dispatch.notify).not.toHaveBeenCalled();
  });

  it("does not raise when the counts fell", async () => {
    const h = setup(
      [{ status: "no_parser", total: "1" }],
      [{ data: { noParser: 3, parseFailed: 0 } }],
    );
    expect(await h.service.evaluate(USER)).toBe(false);
    expect(h.dispatch.notify).not.toHaveBeenCalled();
  });

  it("raises again when a count grew", async () => {
    const h = setup(
      [{ status: "no_parser", total: "5" }],
      [{ data: { noParser: 3, parseFailed: 0 } }],
    );
    expect(await h.service.evaluate(USER)).toBe(true);
    expect(h.dispatch.notify).toHaveBeenCalledTimes(1);
  });

  it("raises when the other group grew even though the first fell", async () => {
    const h = setup(
      [
        { status: "no_parser", total: "1" },
        { status: "parse_failed", total: "1" },
      ],
      [{ data: { noParser: 3, parseFailed: 0 } }],
    );
    expect(await h.service.evaluate(USER)).toBe(true);
  });

  it("treats a previous row without counts as zero", async () => {
    const h = setup([{ status: "no_parser", total: "1" }], [{ data: null }]);
    expect(await h.service.evaluate(USER)).toBe(true);
  });

  it("returns false when another replica already holds the row", async () => {
    const h = setup([{ status: "no_parser", total: "1" }]);
    h.dispatch.notify.mockResolvedValue(null);
    expect(await h.service.evaluate(USER)).toBe(false);
  });

  it("logs and swallows a failure so the poll goes on", async () => {
    const h = setup([{ status: "no_parser", total: "1" }]);
    h.dispatch.notify.mockRejectedValue(new Error("boom"));
    await expect(h.service.evaluate(USER)).resolves.toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});
