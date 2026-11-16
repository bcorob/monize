import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  createIntegrationModule,
  cleanTables,
  deleteBondInstrumentBypassingImmutability,
  deleteBondProgramBypassingImmutability,
  insertBondProgram,
} from "../helpers/integration-setup";

/**
 * INV-BOND-001 against a real PostgreSQL: a bond terms version and a bond
 * period rate are immutable once written. The guard is a trigger, so only a
 * database-backed test can prove it -- a mock would prove the call, not the
 * property.
 */
describe("bond reference tables (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let instrumentId: string;
  let programId: string;

  const termsJson = JSON.stringify({ schemaVersion: 1 });

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'z', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    programId = await insertBondProgram(dataSource, "EDO", "PLN", "PL", "MF");
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ('PL', 'MF', 'EDO', $1, 'EDO0136', 'PLN', 'NON_MARKETABLE')
       RETURNING id`,
      [programId],
    );
    instrumentId = rows[0].id;
    await dataSource.query(
      `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
       VALUES ($1, 1, $2::jsonb, repeat('a', 64), 'https://example.test/terms', NOW())`,
      [instrumentId, termsJson],
    );
    await dataSource.query(
      `INSERT INTO bond_period_rates (bond_instrument_id, period_number, annual_rate, source_url, retrieved_at)
       VALUES ($1, 1, 0.0560000000, 'https://example.test/rates', NOW())`,
      [instrumentId],
    );
  });

  it("refuses UPDATE of a terms version", async () => {
    await expect(
      dataSource.query(
        `UPDATE bond_terms_versions SET source_url = 'x' WHERE bond_instrument_id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/bond_terms_versions.*INV-BOND-001/);
  });

  it("refuses DELETE of a terms version", async () => {
    await expect(
      dataSource.query(
        `DELETE FROM bond_terms_versions WHERE bond_instrument_id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/bond_terms_versions.*INV-BOND-001/);
  });

  it("refuses UPDATE of a period rate", async () => {
    await expect(
      dataSource.query(
        `UPDATE bond_period_rates SET annual_rate = 0.07 WHERE bond_instrument_id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/bond_period_rates.*INV-BOND-001/);
  });

  it("refuses DELETE of a period rate", async () => {
    await expect(
      dataSource.query(
        `DELETE FROM bond_period_rates WHERE bond_instrument_id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/bond_period_rates.*INV-BOND-001/);
  });

  it("leaves the stored rows unchanged after a refused write", async () => {
    await dataSource
      .query(`UPDATE bond_period_rates SET annual_rate = 0.07`)
      .catch(() => undefined);
    const rows: Array<{ annual_rate: string }> = await dataSource.query(
      `SELECT annual_rate FROM bond_period_rates WHERE bond_instrument_id = $1`,
      [instrumentId],
    );
    expect(Number(rows[0].annual_rate)).toBe(0.056);
  });

  it("accepts a second terms version for the same instrument", async () => {
    await dataSource.query(
      `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
       VALUES ($1, 2, $2::jsonb, repeat('b', 64), 'https://example.test/terms-v2', NOW())`,
      [instrumentId, termsJson],
    );
    const rows: Array<{ version: number }> = await dataSource.query(
      `SELECT version FROM bond_terms_versions WHERE bond_instrument_id = $1 ORDER BY version`,
      [instrumentId],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it("refuses a duplicate version of the same issue", async () => {
    await expect(
      dataSource.query(
        `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
         VALUES ($1, 1, $2::jsonb, repeat('c', 64), 'https://example.test/dup', NOW())`,
        [instrumentId, termsJson],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses UPDATE of a bond instrument, leaving the row as written", async () => {
    await expect(
      dataSource.query(
        `UPDATE bond_instruments SET currency_code = 'EUR' WHERE id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/immutable/);
    const rows: Array<{ currency_code: string }> = await dataSource.query(
      `SELECT currency_code FROM bond_instruments WHERE id = $1`,
      [instrumentId],
    );
    expect(rows[0].currency_code).toBe("PLN");
  });

  it("refuses DELETE of a bond instrument", async () => {
    await expect(
      dataSource.query(`DELETE FROM bond_instruments WHERE id = $1`, [
        instrumentId,
      ]),
    ).rejects.toThrow(/immutable/);
    expect(
      await dataSource.query(`SELECT 1 FROM bond_instruments WHERE id = $1`, [
        instrumentId,
      ]),
    ).toHaveLength(1);
  });

  it("refuses UPDATE and DELETE of a bond program (INV-BOND-001), leaving the row as written", async () => {
    await expect(
      dataSource.query(
        `UPDATE bond_programs SET currency_code = 'EUR' WHERE id = $1`,
        [programId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      dataSource.query(`DELETE FROM bond_programs WHERE id = $1`, [programId]),
    ).rejects.toThrow(/immutable/);
    const rows: Array<{ currency_code: string }> = await dataSource.query(
      `SELECT currency_code FROM bond_programs WHERE id = $1`,
      [programId],
    );
    expect(rows).toEqual([{ currency_code: "PLN" }]);
  });

  it("refuses to delete a program that still has a series (ON DELETE RESTRICT), once the immutability trigger is out of the way", async () => {
    await expect(
      deleteBondProgramBypassingImmutability(
        dataSource,
        `DELETE FROM bond_programs WHERE id = $1`,
        [programId],
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });

  it("refuses an instrument with no program, and a program in a currency that does not exist", async () => {
    await expect(
      dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, series_code, currency_code, marketability)
         VALUES ('PL', 'MF', 'EDO', 'EDO0237', 'PLN', 'NON_MARKETABLE')`,
      ),
    ).rejects.toThrow(/null value|not-null/);
    await expect(
      dataSource.query(
        `INSERT INTO bond_programs (issuer_country_code, issuer_code, program_code, currency_code)
         VALUES ('PL', 'MF', 'ZZZ', 'XXX')`,
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });

  it("keeps a program unique per issuer country, issuer and program code", async () => {
    await expect(
      dataSource.query(
        `INSERT INTO bond_programs (issuer_country_code, issuer_code, program_code, currency_code)
         VALUES ('PL', 'MF', 'EDO', 'PLN')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/);
  });

  it("refuses to delete an instrument that still has terms (ON DELETE RESTRICT), once the immutability trigger is out of the way", async () => {
    await expect(
      deleteBondInstrumentBypassingImmutability(
        dataSource,
        `DELETE FROM bond_instruments WHERE id = $1`,
        [instrumentId],
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });

  it("refuses a benchmark value for an unknown benchmark_code", async () => {
    await expect(
      dataSource.query(
        `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
         VALUES ('NO_SUCH_SERIES', '2026-01-01', 0.05, 'https://example.test/v', NOW())`,
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });

  it("accepts a benchmark value for a known series and refuses an unknown kind", async () => {
    await dataSource.query(
      `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
       VALUES ('TEST_STEP', 'STEP', 'TEST', 'https://example.test/s', 'RATE_FRACTION')`,
    );
    await dataSource.query(
      `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
       VALUES ('TEST_STEP', '2026-01-01', 0.0475, 'https://example.test/v', NOW())`,
    );
    await expect(
      dataSource.query(
        `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
         VALUES ('BAD', 'DAILY', 'TEST', 'https://example.test/s', 'RATE_FRACTION')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
