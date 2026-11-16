import { DataSource } from "typeorm";

import {
  AI_REVIEW_CLAIM_TIMEOUT_MINUTES,
  AI_REVIEW_RELEASE_BATCH,
  AI_REVIEW_RELEASE_MAX_BATCHES,
  AiReviewRequestsExpiryService,
} from "./ai-review-requests-expiry.service";
import { AiReviewNotificationService } from "./ai-review-notification.service";
import { AiReviewRequestsService } from "./ai-review-requests.service";
import { withSystemContext } from "../common/db/with-context";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

describe("AiReviewRequestsExpiryService", () => {
  let service: AiReviewRequestsExpiryService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let requests: { expireStale: jest.Mock };
  let notifications: { notifyReady: jest.Mock };

  const rows = (n: number) => [
    Array.from({ length: n }, () => ({ id: "x" })),
    n,
  ];

  beforeEach(() => {
    ({ dataSource, manager } = createScopedDbMocks([]));
    requests = { expireStale: jest.fn().mockResolvedValue(0) };
    notifications = { notifyReady: jest.fn().mockResolvedValue(0) };
    service = new AiReviewRequestsExpiryService(
      dataSource as unknown as DataSource,
      requests as unknown as AiReviewRequestsService,
      notifications as unknown as AiReviewNotificationService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it("is a no-op when nothing is expired or stale", async () => {
    manager.query.mockResolvedValue(rows(0));

    await expect(service.sweepQueue()).resolves.toEqual({
      expired: 0,
      released: 0,
    });

    expect(requests.expireStale).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it("runs both steps under the system context, expiry first", async () => {
    const order: string[] = [];
    requests.expireStale.mockImplementation(async () => {
      order.push("expire");
      return 3;
    });
    manager.query.mockImplementation(async () => {
      order.push("release");
      return rows(2);
    });

    await expect(service.sweepQueue()).resolves.toEqual({
      expired: 3,
      released: 2,
    });

    expect(withSystemContext).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["expire", "release"]);
  });

  it("raises the ready notices after expiry and release", async () => {
    const order: string[] = [];
    requests.expireStale.mockImplementation(async () => {
      order.push("expire");
      return 1;
    });
    manager.query.mockImplementation(async () => {
      order.push("release");
      return rows(0);
    });
    notifications.notifyReady.mockImplementation(async () => {
      order.push("notify");
      return 1;
    });

    await service.sweepQueue();

    expect(order).toEqual(["expire", "release", "notify"]);
  });

  it("does not let a failing ready step break the sweep", async () => {
    requests.expireStale.mockResolvedValue(2);
    manager.query.mockResolvedValue(rows(0));
    notifications.notifyReady.mockRejectedValue(new Error("boom"));
    const warn = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);

    await expect(service.sweepQueue()).resolves.toEqual({
      expired: 2,
      released: 0,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("releases only unexpired claimed rows past the timeout, by the database clock", async () => {
    manager.query.mockResolvedValue(rows(0));

    await service.sweepQueue();

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(
      /SET status = 'pending',\s+claimed_by = NULL,\s+claimed_at = NULL/,
    );
    expect(sql).toMatch(/status = 'claimed'/);
    expect(sql).toMatch(
      /claimed_at < CURRENT_TIMESTAMP - make_interval\(mins => \$1\)/,
    );
    expect(sql).toMatch(/expires_at > CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/LIMIT \$2\s+FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual([
      AI_REVIEW_CLAIM_TIMEOUT_MINUTES,
      AI_REVIEW_RELEASE_BATCH,
    ]);
  });

  it("loops while release batches come back full", async () => {
    manager.query
      .mockResolvedValueOnce(rows(AI_REVIEW_RELEASE_BATCH))
      .mockResolvedValueOnce(rows(4));

    const result = await service.sweepQueue();

    expect(result.released).toBe(AI_REVIEW_RELEASE_BATCH + 4);
    expect(manager.query).toHaveBeenCalledTimes(2);
  });

  it("caps the release passes one run may make", async () => {
    manager.query.mockResolvedValue(rows(AI_REVIEW_RELEASE_BATCH));

    await service.sweepQueue();

    expect(manager.query).toHaveBeenCalledTimes(AI_REVIEW_RELEASE_MAX_BATCHES);
  });

  it("warns and swallows a failure instead of throwing out of the cron", async () => {
    requests.expireStale.mockRejectedValue(new Error("boom"));
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        "warn",
      )
      .mockImplementation();

    await expect(service.sweepQueue()).resolves.toEqual({
      expired: 0,
      released: 0,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
