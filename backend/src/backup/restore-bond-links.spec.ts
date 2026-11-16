import { Logger } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { BackupData } from "./backup-format";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

const PRESENT = "11111111-1111-5111-8111-111111111111";
const ABSENT = "22222222-2222-5222-8222-222222222222";

function setup(catalog: Array<{ id: string; currency_code: string }>) {
  const query = jest.fn().mockResolvedValue(catalog);
  const manager = { query } as unknown as EntityManager;
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  return { service: new BackupRestoreDatabaseService(), manager, query, warn };
}

const data = (securities: Record<string, unknown>[]): BackupData =>
  ({ version: 1, exportedAt: "x", securities }) as unknown as BackupData;

describe("BackupRestoreDatabaseService.severUnavailableCatalogLinks", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps a link to an instrument the deployment carries, in the security's currency", async () => {
    const { service, manager, warn } = setup([
      { id: PRESENT, currency_code: "PLN" },
    ]);
    const backup = data([
      { id: "s1", currency_code: "PLN", bond_program_id: PRESENT },
    ]);
    await expect(
      service.severUnavailableCatalogLinks(manager, backup),
    ).resolves.toEqual({ counts: {}, severed: {} });
    expect(backup.securities[0].bond_program_id).toBe(PRESENT);
    expect(warn).not.toHaveBeenCalled();
  });

  it("restores a link to an instrument this catalog lacks as NULL, and logs it", async () => {
    const { service, manager, warn } = setup([
      { id: PRESENT, currency_code: "PLN" },
    ]);
    const original = [
      {
        id: "s1",
        symbol: "EDO0136",
        currency_code: "PLN",
        bond_program_id: ABSENT,
      },
      { id: "s2", currency_code: "PLN", bond_program_id: PRESENT },
      { id: "s3", currency_code: "USD", bond_program_id: null },
    ];
    const backup = data(original);
    await expect(
      service.severUnavailableCatalogLinks(manager, backup),
    ).resolves.toEqual({
      counts: { "securities.bond_program_id": 1 },
      severed: {
        "securities.bond_program_id": [{ id: "s1", symbol: "EDO0136" }],
      },
    });
    expect(backup.securities.map((r) => r.bond_program_id)).toEqual([
      null,
      PRESENT,
      null,
    ]);
    // New rows, not a mutation of the rows the file produced.
    expect(original[0].bond_program_id).toBe(ABSENT);
    expect(warn.mock.calls[0][0]).toMatch(
      /1 securities\.bond_program_id reference.*does not carry/,
    );
  });

  it("drops a link whose currency differs from the security's (INV-PRICE-001)", async () => {
    const { service, manager, warn } = setup([
      { id: PRESENT, currency_code: "PLN" },
    ]);
    const backup = data([
      { id: "s1", currency_code: "USD", bond_program_id: PRESENT },
    ]);
    await expect(
      service.severUnavailableCatalogLinks(manager, backup),
    ).resolves.toMatchObject({
      counts: { "securities.bond_program_id": 1 },
    });
    expect(backup.securities[0].bond_program_id).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/another currency/);
  });

  it("drops the engine's price rows of a security it unlinked, and only those", async () => {
    const { service, manager } = setup([{ id: PRESENT, currency_code: "PLN" }]);
    const backup = {
      ...data([
        { id: "s1", currency_code: "PLN", bond_program_id: ABSENT },
        { id: "s2", currency_code: "PLN", bond_program_id: PRESENT },
      ]),
      security_prices: [
        { security_id: "s1", source: "bond_engine" },
        { security_id: "s1", source: "manual" },
        { security_id: "s1", source: "buy" },
        { security_id: "s2", source: "bond_engine" },
      ],
    } as unknown as BackupData;
    await service.severUnavailableCatalogLinks(manager, backup);
    expect(backup.security_prices).toEqual([
      { security_id: "s1", source: "manual" },
      { security_id: "s1", source: "buy" },
      { security_id: "s2", source: "bond_engine" },
    ]);
  });

  it("checks every entry of the catalog list, not only the bond link", async () => {
    // A second catalog reference, as a future migration might add one: the
    // existence check applies to it with no further code.
    const query = jest.fn().mockResolvedValue([{ id: PRESENT }]);
    const manager = { query } as unknown as EntityManager;
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const backup = {
      ...data([]),
      transactions: [
        { id: "t1", fund_id: ABSENT },
        { id: "t2", fund_id: PRESENT },
      ],
    } as unknown as BackupData;
    const { counts } =
      await new BackupRestoreDatabaseService().severUnavailableCatalogLinks(
        manager,
        backup,
        { transactions: { fund_id: "fund_catalog" } },
      );
    expect(counts).toEqual({ "transactions.fund_id": 1 });
    expect(query.mock.calls[0][0]).toMatch(/FROM fund_catalog WHERE id = ANY/);
    expect(query.mock.calls[0][0]).not.toMatch(/currency_code/);
    expect(
      (
        backup as unknown as { transactions: Array<{ fund_id: unknown }> }
      ).transactions.map((r) => r.fund_id),
    ).toEqual([null, PRESENT]);
  });

  it("refuses a catalog table name that is not a plain identifier", async () => {
    const { service, manager } = setup([]);
    await expect(
      service.severUnavailableCatalogLinks(
        manager,
        data([{ id: "s1", bond_program_id: PRESENT }]),
        { securities: { bond_program_id: "bond_programs; DROP" } },
      ),
    ).rejects.toThrow(/Invalid catalog table name/);
  });

  it("asks the catalog nothing when no security is linked", async () => {
    const { service, manager, query } = setup([]);
    await service.severUnavailableCatalogLinks(
      manager,
      data([{ id: "s1", currency_code: "PLN" }]),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("restores a transaction's series this catalog lacks as NULL, keeps one it carries, and reports the count", async () => {
    // One query per catalog column: securities (programs), then transactions
    // (instruments). The mock answers the first with no securities to ask about.
    const query = jest.fn().mockResolvedValue([{ id: PRESENT }]);
    const manager = { query } as unknown as EntityManager;
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const backup = {
      ...data([]),
      investment_transactions: [
        { id: "t1", bond_instrument_id: ABSENT },
        { id: "t2", bond_instrument_id: PRESENT },
        { id: "t3", bond_instrument_id: null },
      ],
    } as unknown as BackupData;
    const result =
      await new BackupRestoreDatabaseService().severUnavailableCatalogLinks(
        manager,
        backup,
      );
    expect(result.counts).toEqual({
      "investment_transactions.bond_instrument_id": 1,
    });
    expect(
      (
        backup as unknown as {
          investment_transactions: Array<{ bond_instrument_id: unknown }>;
        }
      ).investment_transactions.map((r) => r.bond_instrument_id),
    ).toEqual([null, PRESENT, null]);
    expect(query.mock.calls[0][0]).toMatch(
      /FROM bond_instruments WHERE id = ANY/,
    );
    expect(query.mock.calls[0][0]).not.toMatch(/currency_code/);
    expect(warn.mock.calls[0][0]).toMatch(
      /1 investment_transactions\.bond_instrument_id reference/,
    );
  });

  it("drops the series of the transactions of a security it unlinked, and only those", async () => {
    const { service, manager } = setup([{ id: PRESENT, currency_code: "PLN" }]);
    const backup = {
      ...data([
        { id: "s1", currency_code: "PLN", bond_program_id: ABSENT },
        { id: "s2", currency_code: "PLN", bond_program_id: PRESENT },
      ]),
      investment_transactions: [
        { id: "t1", security_id: "s1", bond_instrument_id: PRESENT },
        { id: "t2", security_id: "s2", bond_instrument_id: PRESENT },
        { id: "t3", security_id: "s1", bond_instrument_id: null },
      ],
    } as unknown as BackupData;
    await service.severUnavailableCatalogLinks(manager, backup);
    expect(
      (
        backup as unknown as {
          investment_transactions: Array<{
            id: string;
            bond_instrument_id: unknown;
          }>;
        }
      ).investment_transactions.map((r) => [r.id, r.bond_instrument_id]),
    ).toEqual([
      ["t1", null],
      ["t2", PRESENT],
      ["t3", null],
    ]);
  });
});
