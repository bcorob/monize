import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

/**
 * A `pg` connection built by hand is outside every door this codebase has.
 *
 * `withScopedDb` is the only way to a table, and it is reached through the
 * TypeORM pool. A `new Client(...)` or `new Pool(...)` is neither: no ambient
 * identity, no GUCs, no policy, and nothing in `eslint.config.mjs` can see it
 * -- the import bans there are on `@nestjs/typeorm` and the with-context
 * module, and `pg` is a legitimate import for type parsers and for the
 * lifecycle scripts. So the boundary is held here instead, as an allowlist that
 * may shrink and never grows without a written reason.
 *
 * The three sanctioned shapes, and why each one cannot use the pool:
 *
 *  - the **pre-boot scripts**, which hold a session advisory lock across many
 *    transactions and run before the Nest container exists
 *    (`common/db/advisory-locks.ts` says why the pool cannot hold that lock);
 *  - the **notification connection**, which holds `LISTEN` -- session state the
 *    pool is explicitly forbidden from carrying -- and touches no table
 *    (`docs/row-level-security-contract.md`, section 4);
 *  - nothing else.
 *
 * `docs/row-level-security-contract.md` sections 3 and 4 are where a fourth
 * entry is argued for, if there ever is one. This spec is what makes adding it
 * a decision rather than an accident.
 */
const SRC = join(__dirname, "..", "..");

/** `file:line` for every hand-built `pg` connection under `src/`. */
function directConnectionSites(): { file: string; line: number }[] {
  const sites: { file: string; line: number }[] = [];
  const files = globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
  for (const file of files.sort()) {
    const relative = file.slice(SRC.length + 1).replace(/\\/g, "/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        const code = text.replace(/\/\/.*$/, "");
        if (/\bnew\s+(pg\.)?(Client|Pool)\s*\(/.test(code)) {
          sites.push({ file: relative, line: index + 1 });
        }
      });
  }
  return sites;
}

describe("direct PostgreSQL connections", () => {
  /**
   * Each entry is a reviewed decision, and the reason is the entry's value.
   */
  const ALLOWED = new Map<string, string>([
    [
      "db-init.ts",
      "Applies schema.sql under the lifecycle advisory lock, before Nest exists.",
    ],
    [
      "db-migrate.ts",
      "Replays migrations under the same lock, across one transaction per file.",
    ],
    [
      "db-demo-check.ts",
      "Probes for the demo user under the same lock, as its own process.",
    ],
    [
      "common/cluster/pg-listener.provider.ts",
      "Holds LISTEN, which is session state the runtime pool must not carry, " +
        "and issues pg_notify(). Touches no table, so there is no tenant to " +
        "establish: docs/row-level-security-contract.md section 4.",
    ],
  ]);

  it("are built only where the contract says", () => {
    const offenders = directConnectionSites().filter(
      (site) => !ALLOWED.has(site.file),
    );

    expect(
      offenders.map((site) => `${site.file}:${site.line}`),
      // A new one means either a table reached outside withScopedDb, or session
      // state on a connection nobody else knows about. Argue it in
      // docs/row-level-security-contract.md before adding it here.
    ).toEqual([]);
  });

  it("names no file that has stopped building one", () => {
    // A stale entry is a permission nobody is using, and the next reader takes
    // it as precedent.
    const actual = new Set(directConnectionSites().map((site) => site.file));

    expect([...ALLOWED.keys()].filter((file) => !actual.has(file))).toEqual([]);
  });

  it("runs nothing but LISTEN and pg_notify on the notification connection", () => {
    // An allowlist entry is a permission to hold a connection, never a
    // permission to reach a row on it. docs/row-level-security-contract.md
    // section 4: "It runs `LISTEN <channel>` and `SELECT pg_notify($1, $2)`,
    // and **nothing else**. No table, no view, no function that reads one."
    // Without this the file-scoped allowlist above would permit a future
    // `client.query("SELECT ... FROM users")` there -- the one thing section 4
    // forbids outright, on a connection with no identity and no policy.
    const source = readFileSync(
      join(SRC, "common/cluster/pg-listener.provider.ts"),
      "utf8",
    );
    const statements = [
      ...source.matchAll(/\.query\(\s*(`[^`]*`|"[^"]*")/g),
    ].map((match) => match[1].slice(1, -1));

    // The vacuity anchor: a regex that stopped matching would otherwise pass.
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^(LISTEN |UNLISTEN |SELECT pg_notify\()/);
    }
  });

  it("finds the sites at all, so the scan cannot pass by seeing nothing", () => {
    // The vacuity anchor: a regex or a glob that silently stops matching would
    // otherwise turn this whole spec green.
    expect(directConnectionSites().length).toBeGreaterThanOrEqual(ALLOWED.size);
  });
});
