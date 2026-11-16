import { Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { getActiveScopedManager } from "../common/db/scoped-db";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { repriceSettledLoanTemplates } from "./reprice-template";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * The after-commit reprice every settlement caller dispatches
 * (`docs/specs/loan-installment-settlement.md` section 12.8): one
 * transaction per schedule, each once; a failure logged and swallowed after
 * a commit, because a rule never makes a create or an import fail; rethrown
 * when the caller is still inside an ambient transaction, which the failed
 * statement has already aborted.
 */
describe("repriceSettledLoanTemplates", () => {
  let schedules: Record<string, jest.Mock>;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    schedules = { findOne: jest.fn().mockResolvedValue(null) };
    scoped = createScopedDbMocks([[ScheduledTransaction, schedules]]);
    (getActiveScopedManager as jest.Mock).mockReturnValue(undefined);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  const dataSource = () => scoped.dataSource as unknown as DataSource;

  it("opens one transaction per schedule, once each, and locks the schedule row it rewrites", async () => {
    await repriceSettledLoanTemplates(dataSource(), ["st-1", "st-2", "st-1"]);

    expect(scoped.dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(schedules.findOne).toHaveBeenCalledTimes(2);
    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: "st-1" },
      lock: { mode: "pessimistic_write" },
    });
    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: "st-2" },
      lock: { mode: "pessimistic_write" },
    });
  });

  it("opens nothing for no schedules", async () => {
    await repriceSettledLoanTemplates(dataSource(), []);
    expect(scoped.dataSource.transaction).not.toHaveBeenCalled();
  });

  it("logs a failure with the schedule it names and goes on to the next, after a commit", async () => {
    schedules.findOne
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(null);

    await expect(
      repriceSettledLoanTemplates(dataSource(), ["st-1", "st-2"]),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("st-1");
    expect(String(warn.mock.calls[0][0])).toContain("connection reset");
    expect(schedules.findOne).toHaveBeenCalledTimes(2);
  });

  it("rethrows a failure when the caller is inside an ambient transaction, which the failed statement aborted", async () => {
    (getActiveScopedManager as jest.Mock).mockReturnValue(
      scoped.manager as unknown as EntityManager,
    );
    schedules.findOne.mockRejectedValue(new Error("connection reset"));

    await expect(
      repriceSettledLoanTemplates(dataSource(), ["st-1"]),
    ).rejects.toThrow("connection reset");
    expect(warn).not.toHaveBeenCalled();
  });
});
