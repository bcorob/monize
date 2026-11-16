import { readFileSync } from "fs";
import { join } from "path";

import { RLS_EXEMPT_TABLES, rlsExemptTableNames } from "./rls-exempt-tables";

/**
 * The RLS exemption list is one list, and this is where that is checked.
 *
 * It used to be four, and they had already diverged:
 * `database/migrations/114_rls_policies_special.sql` documented four tables, the
 * exemption block at the foot of `database/schema.sql` documented six, and
 * `backend/test/integration/rls-enforcement.integration.spec.ts` and
 * `backend/test/integration/rls-enable.integration.spec.ts` each carried their
 * own six-entry array -- the second under a test named "leaves the four exempt
 * tables untouched". `database/CLAUDE.md` made five. The migration asserted that
 * "the catalog-driven test in T2 asserts this exact list" while the test
 * asserted a different one.
 *
 * Nothing caught any of it, because both integration specs need a live
 * PostgreSQL and neither runs in `npm run test:unit`. This spec needs no
 * database: it reads the schema's marker block and compares it with the
 * constant the specs now import, in **both** directions -- a table added to the
 * constant without the schema fails, and so does the reverse.
 *
 * Per `docs/backend/backup.md`: a scan that names a file is disarmed silently when
 * that file moves or its marker is edited away, so a missing block **throws**
 * rather than comparing against an empty set.
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

/** The marker the schema block uses, and this spec's whole contract with it. */
const EXEMPT_MARKER = /^--\s*rls-exempt:\s*([a-z_][a-z0-9_]*)\s*$/gim;

/**
 * Table names declared exempt by `database/schema.sql`.
 *
 * Throws when the block is absent: an empty result would make every assertion
 * below pass while checking nothing, which is the exact failure mode that let
 * the four copies drift.
 */
export function parseSchemaExemptTables(sql: string): string[] {
  const names = [...sql.matchAll(EXEMPT_MARKER)].map((match) => match[1]);
  if (names.length === 0) {
    throw new Error(
      "No `-- rls-exempt: <table>` lines found in database/schema.sql. The " +
        "marker block was renamed or removed; restore it, or this guard is " +
        "checking nothing. See docs/row-level-security-contract.md.",
    );
  }
  return names.sort();
}

describe("RLS exemption list", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf8");

  it("finds the marker block it is meant to check", () => {
    // Anti-vacuity. A regex that silently matched nothing would make the
    // both-directions assertion below trivially true.
    const parsed = parseSchemaExemptTables(schema);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed).toContain("oauth_payloads");
  });

  it("throws rather than passing when the marker block is gone", () => {
    expect(() => parseSchemaExemptTables("-- no markers here\n")).toThrow(
      /marker block was renamed or removed/,
    );
  });

  it("matches database/schema.sql in both directions", () => {
    // Both directions on purpose: a one-way check passes when the schema grows
    // an exemption the application does not know about, which is the direction
    // that silently widens the unpolicied surface.
    expect(parseSchemaExemptTables(schema)).toEqual(rlsExemptTableNames());
  });

  it("gives every exempt table a one-line reason", () => {
    const unexplained = Object.entries(RLS_EXEMPT_TABLES)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([table]) => table);
    expect(unexplained).toEqual([]);
  });

  it("points every reader at the canonical rationale", () => {
    // The schema block is the machine-readable set; the reasoning lives in one
    // place, and the pointer is what keeps it from being copied back here.
    expect(schema).toContain("docs/row-level-security-contract.md");
  });
});
