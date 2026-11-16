import { readFileSync } from "fs";
import { join } from "path";

import { SCHEDULED_POSTING_SOURCES } from "./scheduled-transaction-posting.entity";

/**
 * `SCHEDULED_POSTING_SOURCES` is one list, and this is where that is checked:
 * `chk_stp_source` in `database/schema.sql` is the only list the database
 * accepts (docs/specs/loan-installment-settlement.md section 5.2), compared in
 * both directions. A source the constant knows and the database refuses fails
 * a claim at runtime; one the database accepts and the constant does not know
 * reads back as a value no writer produces.
 */

const SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "database",
  "schema.sql",
);

/** The `CREATE TABLE scheduled_transaction_postings (...)` body alone. */
const schema = (() => {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const start = sql.indexOf("CREATE TABLE scheduled_transaction_postings (");
  if (start < 0) {
    throw new Error(
      "No `CREATE TABLE scheduled_transaction_postings` in database/schema.sql",
    );
  }
  return sql.slice(start, sql.indexOf("\n);", start));
})();

function parseCheck(name: string, pattern: RegExp): RegExpExecArray {
  const match = pattern.exec(schema);
  if (!match) {
    throw new Error(
      `No \`CONSTRAINT ${name}\` found in database/schema.sql in the expected ` +
        "form. The constraint was renamed or reworded; update this parser, or " +
        "this guard is checking nothing.",
    );
  }
  return match;
}

describe("scheduled_transaction_postings schema contract", () => {
  it("admits exactly the sources the constant names", () => {
    const match = parseCheck(
      "chk_stp_source",
      /CONSTRAINT\s+chk_stp_source\s+CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i,
    );
    const admitted = [...match[1].matchAll(/'([^']*)'/g)]
      .map((m) => m[1])
      .sort();

    expect(admitted).toEqual([...SCHEDULED_POSTING_SOURCES].sort());
  });

  it("defaults a claim to the bill's own post", () => {
    const match = parseCheck(
      "source column",
      /^\s*source\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'([^']*)'/im,
    );

    expect(match[1]).toBe("post");
    expect(SCHEDULED_POSTING_SOURCES).toContain(match[1]);
  });

  it("requires a rule claim to name its transaction", () => {
    parseCheck(
      "chk_stp_rule_claim_transaction",
      /CONSTRAINT\s+chk_stp_rule_claim_transaction\s+CHECK\s*\(\s*source\s*=\s*'post'\s+OR\s+transaction_id\s+IS\s+NOT\s+NULL\s*\)/i,
    );
  });
});
