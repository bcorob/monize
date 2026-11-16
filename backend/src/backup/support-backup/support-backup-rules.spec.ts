import { readFileSync } from "fs";
import { join } from "path";

import {
  ALWAYS_EXCLUDED_TABLES,
  RULES,
  SECTION_NONFK_CLEANUP,
  SECTION_TABLES,
} from "./support-backup-rules";

/**
 * Drift guards for the hand-maintained section maps. The golden integration
 * test ties RULES to the live schema; these unit checks tie the section
 * machinery to RULES so a new table or column can't silently bypass a
 * section checkbox or point the FK cleanup at nothing.
 */
describe("support backup rules registry", () => {
  it("every sectioned table is classified and owned by exactly one section", () => {
    const seen = new Map<string, string>();
    for (const [section, tables] of Object.entries(SECTION_TABLES)) {
      for (const table of tables) {
        expect(RULES[table]).toBeDefined();
        expect(seen.get(table)).toBeUndefined();
        seen.set(table, section);
      }
    }
  });

  it("every non-FK cleanup target exists in the rules registry", () => {
    for (const cleanups of Object.values(SECTION_NONFK_CLEANUP)) {
      for (const { table, column } of cleanups ?? []) {
        expect(RULES[table]).toBeDefined();
        expect(RULES[table][column]).toBeDefined();
      }
    }
  });

  it("drops the bond links: they name the masked program and series, and the copy's scaled quantities are not whole bonds", () => {
    expect(RULES.securities.bond_program_id?.t).toBe("drop");
    expect(RULES.investment_transactions.bond_instrument_id?.t).toBe("drop");
  });

  it("keeps the auto-fetch flag: it re-identifies nobody", () => {
    expect(RULES.securities.bond_auto_fetch?.t).toBe("keep");
  });

  it("keeps the structural columns a restored GEM signal is read by", () => {
    // RULES is an allowlist, so an unclassified column is dropped -- and for
    // these two that is not a safe default but a change of meaning. A signal
    // restored without `algorithm_version` takes the column default of 1, the
    // reader files it as an older version's record, and it vanishes from the
    // current history and the backtest. Without `config_fingerprint` every
    // restored row looks stale and is recomputed on the first read.
    expect(RULES.gem_strategy_signals.algorithm_version).toEqual({ t: "keep" });
    expect(RULES.gem_strategy_signals.config_fingerprint).toEqual({
      t: "keep",
    });
  });

  it("always-excluded tables have no rules (they are never emitted)", () => {
    for (const table of ALWAYS_EXCLUDED_TABLES) {
      expect(RULES[table]).toBeUndefined();
    }
  });

  /**
   * A `drop` writes NULL. On a NOT NULL column with no DEFAULT that is a value
   * the restore cannot insert -- and a support backup restores through the same
   * path as any other (`docs/backup-restore-contract.md` section 9), so the
   * insert raises and takes the whole restore transaction with it. The
   * de-identified form of such a column is `konst(...)`, which is what the
   * `ColumnRule` union says it is for.
   *
   * A source scan rather than a case per column: the mistake is mechanical and
   * arrives with every new NOT NULL text column, which is exactly when nobody
   * is looking at this file.
   */
  it("never drops a NOT NULL column that has no default", () => {
    const schema = readFileSync(
      join(__dirname, "../../../../database/schema.sql"),
      "utf8",
    );

    const offenders: string[] = [];
    for (const [table, rules] of Object.entries(RULES)) {
      const columns = schema.match(
        new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`),
      )?.[1];
      if (!columns) continue;
      for (const line of columns.split("\n")) {
        const text = line.trim();
        if (!/NOT NULL/.test(text) || /DEFAULT/.test(text)) continue;
        const column = text.split(/\s+/)[0];
        // Skip a table-level CONSTRAINT clause, which has no column name here.
        if (!/^[a-z_]+$/.test(column)) continue;
        if (rules[column]?.t === "drop") offenders.push(`${table}.${column}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
