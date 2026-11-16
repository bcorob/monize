import { execFileSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import {
  LEGACY_PREFIX_CEILING,
  LEGACY_PREFIX_WIDTH,
  TIMESTAMP_PREFIX_WIDTH,
  TIMESTAMP_SCHEME_ADOPTED,
  compareMigrationFilenames,
  orderMigrations,
  parseMigrationPrefix,
  timestampPrefixFor,
  timestampPrefixToDate,
} from "./migration-filename";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "../repo-tree.util";

const REPO_ROOT = findRepoRoot(__dirname);
const MIGRATIONS_DIR = REPO_ROOT
  ? join(REPO_ROOT, "database", "migrations")
  : "";
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

/**
 * A listing a string sort gets wrong. Every real historical prefix begins with
 * 0 or 1 and every timestamp with 2, so on the real directory the two orders
 * happen to agree; 205 is above today's ceiling (the prefix check refuses one)
 * and is exactly the shape that shows the agreement is a coincidence of
 * digits: a string sort puts it AFTER both timestamps, numeric order before.
 */
const MIXED_WIDTH_FIXTURE = [
  "20260905143000_new.sql",
  "205_beyond_ceiling.sql",
  "168_existing.sql",
  "022_a.sql",
  "022_b.sql",
  "117_z.sql",
  "117_a.sql",
  "20260905142959_earlier.sql",
];

const MIXED_WIDTH_EXPECTED = [
  "022_a.sql",
  "022_b.sql",
  "117_a.sql",
  "117_z.sql",
  "168_existing.sql",
  "205_beyond_ceiling.sql",
  "20260905142959_earlier.sql",
  "20260905143000_new.sql",
];

describe("parseMigrationPrefix", () => {
  it("reads the historical three-digit form and the fourteen-digit timestamp form", () => {
    expect(parseMigrationPrefix("022_add_thing.sql")).toEqual({
      kind: "legacy",
      value: 22,
      text: "022",
    });
    expect(parseMigrationPrefix("20260905143000_heal_something.sql")).toEqual({
      kind: "timestamp",
      value: 20260905143000,
      text: "20260905143000",
    });
  });

  it("refuses every other width, so a stray form is never ordered somewhere surprising", () => {
    for (const name of [
      "1000_four_digits.sql",
      "2026090514300_thirteen.sql",
      "202609051430001_fifteen.sql",
      "12_two.sql",
      "no_prefix.sql",
      "_leading_underscore.sql",
      "",
    ]) {
      expect(parseMigrationPrefix(name)).toBeNull();
    }
  });

  it("keeps the two widths as named constants the scripts can quote", () => {
    expect(LEGACY_PREFIX_WIDTH).toBe(3);
    expect(TIMESTAMP_PREFIX_WIDTH).toBe(14);
    expect(String(TIMESTAMP_SCHEME_ADOPTED)).toHaveLength(
      TIMESTAMP_PREFIX_WIDTH,
    );
  });
});

describe("timestampPrefixToDate", () => {
  it("names the UTC instant the digits spell", () => {
    expect(timestampPrefixToDate("20260905143000")?.toISOString()).toBe(
      "2026-09-05T14:30:00.000Z",
    );
  });

  it("rejects digits that do not spell a real date or time", () => {
    // Date.UTC would silently normalize each of these into a different day;
    // the round trip is what refuses them.
    for (const text of [
      "20261305143000", // month 13
      "20260230143000", // 30 February
      "20260905243000", // hour 24
      "20260905146000", // minute 60
      "20260905143060", // second 60
      "2026090514300", // thirteen digits
      "abcdefghijklmn",
    ]) {
      expect(timestampPrefixToDate(text)).toBeNull();
    }
  });

  it("round-trips through timestampPrefixFor", () => {
    const instant = new Date("2026-09-05T14:30:00Z");
    const text = timestampPrefixFor(instant);
    expect(text).toBe("20260905143000");
    expect(timestampPrefixToDate(text)?.getTime()).toBe(instant.getTime());
  });
});

describe("compareMigrationFilenames / orderMigrations", () => {
  it("orders by the numeric prefix, so a wider prefix applies after every historical migration", () => {
    expect(orderMigrations(MIXED_WIDTH_FIXTURE)).toEqual(MIXED_WIDTH_EXPECTED);
  });

  it("is a different order from a string sort on that fixture, so the test is not vacuous", () => {
    const stringSorted = [...MIXED_WIDTH_FIXTURE].sort();
    expect(stringSorted).not.toEqual(MIXED_WIDTH_EXPECTED);
    // Specifically: a string sort places the wider prefix by its leading
    // digits, so the three-digit 205 lands after both timestamps.
    expect(stringSorted[stringSorted.length - 1]).toBe(
      "205_beyond_ceiling.sql",
    );
  });

  it("breaks a shared prefix on the full filename, which is how the historical pairs were applied", () => {
    expect(compareMigrationFilenames("117_a.sql", "117_z.sql")).toBeLessThan(0);
    expect(compareMigrationFilenames("117_z.sql", "117_a.sql")).toBeGreaterThan(
      0,
    );
    expect(compareMigrationFilenames("117_a.sql", "117_a.sql")).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = [...MIXED_WIDTH_FIXTURE];
    orderMigrations(input);
    expect(input).toEqual(MIXED_WIDTH_FIXTURE);
  });

  it("refuses a filename it cannot order rather than placing it somewhere", () => {
    expect(() => orderMigrations(["001_a.sql", "1000_b.sql"])).toThrow(
      /cannot order migration filename "1000_b.sql"/,
    );
    expect(() => compareMigrationFilenames("001_a.sql", "stray.sql")).toThrow(
      /cannot order migration filename "stray.sql"/,
    );
  });
});

describe("the shell replay in scripts/verify-schema.sh orders the same way", () => {
  // `verify-schema.sh` cannot import the comparator, so it uses
  // `ls | grep '\.sql$' | sort -n`. This runs that exact pipeline over the
  // mixed-width fixture and checks it against the TypeScript order -- the
  // shell's "leading digits as a number, ties on the whole line" has to be the
  // same rule, and a guard that merely greps the script for `sort -n` would
  // not know whether it is.
  const hasSort = (() => {
    try {
      execFileSync("sort", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const itWithSort = hasSort || process.env.CI ? it : it.skip;

  itWithSort(
    "sort -n agrees with compareMigrationFilenames on the fixture",
    () => {
      const shellOrder = execFileSync(
        "sh",
        ["-c", "grep '\\.sql$' | sort -n"],
        {
          input: `${MIXED_WIDTH_FIXTURE.join("\n")}\nREADME.md\n`,
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n");
      expect(shellOrder).toEqual(MIXED_WIDTH_EXPECTED);
    },
  );

  itWithSort("the script still uses that pipeline", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const script = readFileSync(
      join(root, "scripts", "verify-schema.sh"),
      "utf8",
    );
    expect(script).toContain("| grep '\\.sql$' | sort -n)");
    // The glob it replaced is a string sort; it must not come back.
    expect(script).not.toMatch(/for f in .*\/database\/migrations\/\*\.sql/);
  });
});

describeTree("the migrations directory", () => {
  const names = () =>
    readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  it("contains only filenames the runner can order", () => {
    const files = names();
    expect(files.length).toBeGreaterThan(100);
    expect(() => orderMigrations(files)).not.toThrow();
  });

  it("holds LEGACY_PREFIX_CEILING in both directions", () => {
    // No historical file above the ceiling: a three-digit prefix above it is
    // a new migration written under the retired scheme, and the check script
    // refuses it on that basis alone. And a file AT the ceiling exists: a
    // constant above the real maximum would let that many new sequential
    // files through.
    const legacyValues = names()
      .map(parseMigrationPrefix)
      .filter(
        (p): p is NonNullable<typeof p> => p !== null && p.kind === "legacy",
      )
      .map((p) => p.value);
    expect(legacyValues.length).toBeGreaterThan(100);
    expect(Math.max(...legacyValues)).toBe(LEGACY_PREFIX_CEILING);
  });

  it("holds every timestamp-prefixed file on or after the scheme's adoption", () => {
    for (const name of names()) {
      const prefix = parseMigrationPrefix(name);
      if (prefix?.kind !== "timestamp") continue;
      expect(timestampPrefixToDate(prefix.text)).not.toBeNull();
      expect(prefix.value).toBeGreaterThanOrEqual(TIMESTAMP_SCHEME_ADOPTED);
    }
  });
});

/**
 * Comments stripped before the scan, with line numbers preserved: the prose
 * explaining this guard has to be able to name the shape it bans.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix: string) =>
        prefix + " ".repeat(match.length - prefix.length),
    );
}

/**
 * A statement that lists a migrations directory and sorts it with no
 * comparator: `readdirSync(...)` and a bare `.sort()` between the same two
 * semicolons, in a statement that also mentions `.sql` or a migrations path.
 * Every place that orders migrations must go through the shared comparator,
 * because a string sort is exactly the defect issue #1277 describes.
 */
function bareMigrationSorts(source: string): number[] {
  const code = blankComments(source);
  const offenders: number[] = [];
  const statement = /[^;]*readdirSync\([^;]*\.sort\(\)[^;]*/g;
  for (const match of code.matchAll(statement)) {
    const text = match[0];
    if (!/\.sql|migrations/i.test(text)) continue;
    const upTo = code.slice(0, match.index + text.indexOf(".sort()"));
    offenders.push(upTo.split("\n").length);
  }
  return offenders;
}

describe("bareMigrationSorts (the scan itself)", () => {
  it("flags a migrations listing sorted as strings", () => {
    const source = [
      "const files = readdirSync(MIGRATIONS_DIR)",
      '  .filter((f) => f.endsWith(".sql"))',
      "  .sort();",
    ].join("\n");
    expect(bareMigrationSorts(source)).toEqual([3]);
  });

  it("passes the same listing sorted with the comparator, and a listing of something else", () => {
    expect(
      bareMigrationSorts(
        'const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort(compareMigrationFilenames);',
      ),
    ).toEqual([]);
    expect(
      bareMigrationSorts("for (const entry of readdirSync(dir).sort()) {}"),
    ).toEqual([]);
  });

  it("is not tripped by prose describing the banned shape", () => {
    const source = [
      "// readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()",
      "/* the old code was readdirSync(dir).sort() over migrations */",
      "const ok = 1;",
    ].join("\n");
    expect(bareMigrationSorts(source)).toEqual([]);
  });
});

describeTree(
  "the repository scripts reach the definition through one loader",
  () => {
    it("imports the .ts file directly from scripts/lib/migration-filename.mjs and nowhere else", () => {
      // The loader is where the MODULE_TYPELESS_PACKAGE_JSON warning is filtered
      // and where the Node-version requirement is stated once; a second direct
      // import would print advice (`"type": "module"`) the backend must not take.
      const root = requireRepoRoot(REPO_ROOT);
      const importers = gitListFiles(root).filter(
        (f) =>
          /\.(mjs|js|cjs)$/.test(f) &&
          /migration-filename\.ts["']/.test(
            readFileSync(join(root, f), "utf8"),
          ),
      );
      expect(importers).toEqual(["scripts/lib/migration-filename.mjs"]);
    });

    it("is imported by both migration scripts through that loader", () => {
      const root = requireRepoRoot(REPO_ROOT);
      for (const script of [
        "scripts/check-migration-prefixes.mjs",
        "backend/scripts/migration-lint.mjs",
      ]) {
        expect(readFileSync(join(root, script), "utf8")).toMatch(
          /from ["'][./]*\/?(?:\.\.\/)*(?:scripts\/)?lib\/migration-filename\.mjs["']/,
        );
      }
    });
  },
);

describeTree(
  "every listing of the migrations directory is ordered through the comparator",
  () => {
    it("finds no bare .sort() on a migrations listing", () => {
      const root = requireRepoRoot(REPO_ROOT);
      const files = gitListFiles(root).filter(
        (f) =>
          /^(backend\/(src|test|scripts)|scripts)\/.+\.(ts|mjs|js)$/.test(f) &&
          f !== relative(root, __filename).replace(/\\/g, "/"),
      );
      expect(files.length).toBeGreaterThan(100);
      const offenders: string[] = [];
      for (const file of files) {
        for (const line of bareMigrationSorts(
          readFileSync(join(root, file), "utf8"),
        )) {
          offenders.push(`${file}:${line}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  },
);
