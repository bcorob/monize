import { DataSource } from "typeorm";

import {
  RULE_APPLICATION_DELETE_BATCH,
  RULE_APPLICATION_MAX_BATCHES,
  RULE_APPLICATION_RETENTION_DAYS,
  TransactionRuleApplicationsRetentionService,
} from "./transaction-rule-applications-retention.service";
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

describe("TransactionRuleApplicationsRetentionService", () => {
  let service: TransactionRuleApplicationsRetentionService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;

  beforeEach(() => {
    ({ dataSource, manager } = createScopedDbMocks([]));
    service = new TransactionRuleApplicationsRetentionService(
      dataSource as unknown as DataSource,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it("is a no-op that runs one batch when nothing is old enough", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await expect(service.purgeExpiredApplications()).resolves.toBe(0);

    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it("runs under the system context", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.purgeExpiredApplications();

    expect(withSystemContext).toHaveBeenCalledTimes(1);
  });

  it("deletes by the database clock in a bounded, skip-locked batch, fully parameterized", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.purgeExpiredApplications();

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM transaction_rule_applications/);
    expect(sql).toMatch(
      /applied_at < CURRENT_TIMESTAMP - make_interval\(days => \$1\)/,
    );
    expect(sql).toMatch(/LIMIT \$2\s+FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual([
      RULE_APPLICATION_RETENTION_DAYS,
      RULE_APPLICATION_DELETE_BATCH,
    ]);
    expect(RULE_APPLICATION_RETENTION_DAYS).toBe(365);
  });

  it("loops while batches come back full and stops at the first short one", async () => {
    manager.query
      .mockResolvedValueOnce([[], RULE_APPLICATION_DELETE_BATCH])
      .mockResolvedValueOnce([[], RULE_APPLICATION_DELETE_BATCH])
      .mockResolvedValueOnce([[], 17]);

    await expect(service.purgeExpiredApplications()).resolves.toBe(
      2 * RULE_APPLICATION_DELETE_BATCH + 17,
    );

    expect(manager.query).toHaveBeenCalledTimes(3);
  });

  it("caps the batches one run may issue", async () => {
    manager.query.mockResolvedValue([[], RULE_APPLICATION_DELETE_BATCH]);

    await service.purgeExpiredApplications();

    expect(manager.query).toHaveBeenCalledTimes(RULE_APPLICATION_MAX_BATCHES);
  });

  it("warns and swallows a failure instead of throwing out of the cron", async () => {
    manager.query.mockRejectedValue(new Error("boom"));
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        "warn",
      )
      .mockImplementation();

    await expect(service.purgeExpiredApplications()).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
