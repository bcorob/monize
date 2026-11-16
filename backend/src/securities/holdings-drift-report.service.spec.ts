import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));

import { Logger } from "@nestjs/common";
import { HoldingsDriftReportService } from "./holdings-drift-report.service";
import { HoldingDiscrepancy } from "./holdings.service";

/**
 * The repair path for a stored holding that predates the ledger-projection
 * rule (INV-HOLDING-001) is a report a human reads, not a rebuild the server
 * runs on their behalf: a rebuild replaces a figure somebody may have
 * reconciled. So the only assertions worth making here are that a mismatch is
 * named and that nothing is written.
 */
describe("HoldingsDriftReportService", () => {
  const USER = "11111111-1111-1111-1111-111111111111";
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let holdingsService: { findLedgerDiscrepancies: jest.Mock };
  let service: HoldingsDriftReportService;
  let warn: jest.SpyInstance;

  const mismatch: HoldingDiscrepancy = {
    accountId: "acc-1",
    securityId: "sec-1",
    storedQuantity: 150,
    storedAverageCost: 15,
    replayedQuantity: 150,
    replayedAverageCost: 2500 / 150,
  };

  /** Every statement that would change a row. */
  const writes = () =>
    manager.query.mock.calls.filter(([sql]) =>
      /\b(INSERT|UPDATE|DELETE)\b/i.test(String(sql)),
    );

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([{ user_id: USER }]);
    holdingsService = { findLedgerDiscrepancies: jest.fn() };
    service = new HoldingsDriftReportService(
      dataSource as never,
      holdingsService as never,
    );
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
    jest.clearAllMocks();
  });

  it("logs a mismatching position with both figures and the repair, and writes nothing", async () => {
    holdingsService.findLedgerDiscrepancies.mockResolvedValue([mismatch]);

    const reported = await service.reportDiscrepancies();

    expect(reported).toBe(1);
    const lines = warn.mock.calls.map(([line]) => String(line));
    const named = lines.find((l) => l.includes("acc-1"));
    expect(named).toBeDefined();
    // The stored figure, the replay's figure, and what to do about it.
    expect(named).toContain("15");
    expect(named).toContain("16.666");
    expect(named).toContain("POST /holdings/rebuild");
    expect(writes()).toHaveLength(0);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it("says nothing about a position that agrees with the replay", async () => {
    holdingsService.findLedgerDiscrepancies.mockResolvedValue([]);

    const reported = await service.reportDiscrepancies();

    expect(reported).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("keeps reporting after one user cannot be read", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    manager.query.mockResolvedValue([{ user_id: USER }, { user_id: other }]);
    holdingsService.findLedgerDiscrepancies
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce([mismatch]);

    const reported = await service.reportDiscrepancies();

    expect(reported).toBe(1);
  });

  it("does not let a failed report stop the application booting", () => {
    manager.query.mockRejectedValue(new Error("relation does not exist"));

    expect(() => service.onApplicationBootstrap()).not.toThrow();
  });
});
