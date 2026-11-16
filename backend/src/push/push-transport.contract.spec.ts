import { readFileSync } from "fs";
import { join } from "path";

import { PUSH_TRANSPORTS } from "./entities/push-subscription.entity";

/**
 * The set of push transports is written twice by necessity -- once as the
 * TypeScript constant the DTO validates against (`@IsIn(PUSH_TRANSPORTS)`), once
 * as the CHECK constraint the database enforces -- and a list that means
 * something is checked in both directions rather than trusted to stay aligned
 * (`AGENTS.md`, "a list of columns that means something is written once, in
 * the place that can check it").
 *
 * The failure this prevents is quiet: a transport added to the constant but not
 * the CHECK passes the DTO and dies in PostgreSQL as 23514, which
 * `isForeignEndpointConflict` does not classify, so the subscriber sees a
 * generic 500 and no log names the list that drifted. The other direction --
 * a value the CHECK admits that the DTO refuses -- is a row nothing can write,
 * which is a dead branch in the schema rather than a defect, but the same
 * drift.
 *
 * Migration 184 and schema.sql both declare the constraint under the same name;
 * schema.sql is the one read here because it is what a fresh install boots
 * from and what `scripts/verify-schema.sh` holds the migrations equal to.
 */
const SCHEMA_PATH = join(__dirname, "..", "..", "..", "database", "schema.sql");

/** The literal set inside `push_subscriptions_transport_check`. */
function transportsInSchema(): string[] {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const match = schema.match(
    /CONSTRAINT\s+push_subscriptions_transport_check\s+CHECK\s*\(\s*transport\s+IN\s*\(([^)]*)\)\s*\)/i,
  );
  if (!match) {
    throw new Error(
      "push_subscriptions_transport_check not found in schema.sql -- the CHECK " +
        "was renamed or dropped, and this contract no longer knows what to hold " +
        "PUSH_TRANSPORTS equal to",
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("push transport contract (PUSH_TRANSPORTS <-> schema CHECK)", () => {
  it("the TypeScript constant and the CHECK constraint name the same transports", () => {
    expect([...PUSH_TRANSPORTS].sort()).toEqual(transportsInSchema().sort());
  });

  it("the default wire is one the CHECK admits", () => {
    // `webpush` is the column default in schema.sql and migration 184 and the
    // value a client that sends no transport is stored under; a default outside
    // the set would make every browser subscribe fail on the CHECK.
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const dflt = schema.match(
      /transport\s+VARCHAR\(\d+\)\s+NOT NULL\s+DEFAULT\s+'([^']+)'/i,
    );
    expect(dflt?.[1]).toBe("webpush");
    expect(transportsInSchema()).toContain("webpush");
  });
});
