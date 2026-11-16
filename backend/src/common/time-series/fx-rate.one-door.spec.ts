import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * `docs/time-series-contract.md` section 2.2: an exchange rate is a price, so
 * turning a stored rate into "the rate for this date" goes through the shared
 * helper that applies the age bound and refuses look-ahead --
 * `common/time-series/fx-rate-resolver.ts`, reached either directly or through
 * `ExchangeRateService.resolveStoredRate` / `getRateForDate`.
 *
 * Issue #1390 is what this guard exists for: four resolvers answered the same
 * question and disagreed, so one session quoted four different EUR rates. The
 * prose form of that rule cannot see a fifth being added, and each of the four
 * looked perfectly reasonable in its own file.
 *
 * What it looks for: a read of the *newest* stored rate -- `getLatestRate(`,
 * or a `rate_date` ordered descending beside a one-row fetch -- outside the
 * door. `getLatestRates()` (the plural admin listing) is not that and is not
 * flagged.
 *
 * The baseline is **shrink-only**. Every entry is a call site that predates the
 * guard, with the reason it is still there; a new one fails the build, and
 * fixing one means deleting its line here in the same change.
 */

const SRC_ROOT = join(__dirname, "..", "..");

/**
 * The door itself, plus the one deliberate exception
 * `docs/time-series-contract.md` section 2.1 records as living *inside* the
 * door: `nearest-observation.ts` answers "what is the closest thing anybody
 * ever observed", explicitly approximate, and carries the observation's date to
 * the user rather than presenting it as that date's rate.
 *
 * `currencies/exchange-rate.service.ts` is deliberately **not** here. It is the
 * door's database side, but exempting the whole file meant a new unbounded
 * newest-rate read inside it passed the guard -- which is exactly how
 * `getLiveRate` came to seed a 276-day-old rate as live (issue #1390). Only
 * `getLatestRate`'s own declaration is exempt; see `DOOR_MEMBERS`.
 */
const DOOR_FILES = new Set([
  "common/time-series/fx-rate-resolver.ts",
  "common/time-series/rate-index.util.ts",
  "common/time-series/nearest-observation.ts",
]);

/**
 * A member whose own body *is* the newest-rate read the rest of the codebase is
 * steered away from, so its lines are not an outside read. Shrink-only, like
 * the baseline: everything else in the same file is scanned.
 */
const DOOR_MEMBERS: ReadonlyArray<{
  file: string;
  /** The declaration line; its body runs to the first line that closes it. */
  declaration: RegExp;
  reason: string;
}> = [
  {
    file: "currencies/exchange-rate.service.ts",
    declaration: /^ {2}async getLatestRate\(/,
    reason:
      "The bounded-age `getLatestRate` itself: the members around it -- " +
      "`resolveStoredRate`, `getRateForDate`, `getLiveRate` -- are scanned " +
      "like any other file, so a new unbounded read inside this service " +
      "fails the guard rather than inheriting a file-wide exemption.",
  },
];

/**
 * Line indices (0-based) inside `rel` that a `DOOR_MEMBERS` entry covers: the
 * declaration through the first line that closes it at the same indent.
 */
function doorMemberLines(rel: string, lines: string[]): Set<number> {
  const covered = new Set<number>();
  for (const member of DOOR_MEMBERS) {
    if (member.file !== rel) continue;
    lines.forEach((line, index) => {
      if (!member.declaration.test(line)) return;
      const indent = line.length - line.trimStart().length;
      const close = `${" ".repeat(indent)}}`;
      for (let i = index; i < lines.length; i++) {
        covered.add(i);
        if (i > index && lines[i] === close) break;
      }
    });
  }
  return covered;
}

/**
 * Call sites still reading a newest-stored-rate outside the resolver.
 *
 * Not endorsements. Each names why it has not moved yet; removing an entry is
 * how INV-FX-001's look-ahead/age clause gets from `partial` to `enforced`.
 */
const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "common/converting-total.ts",
    reason:
      "Declares the `getLatestRate` shape its rate source must satisfy; the " +
      "implementation it is handed is ExchangeRateService's, and the ladder " +
      "beside it (`getRateForDate`) is what the dated callers use. A type " +
      "declaration, not a lookup.",
  },
  {
    file: "common/fx-entry.util.ts",
    reason:
      "`resolveFxRateOrNull` is the one market-rate ladder and calls " +
      "getLatestRate only on the branch where the caller has no date at all " +
      "(a rate entered against no posting date). That read is bounded by " +
      "`getLatestRate`'s default of FX_MAX_RATE_AGE_DAYS; moving the branch " +
      "onto a dated lookup means deciding what a dateless entry means, which " +
      "is its own change.",
  },
  {
    file: "scheduled-transactions/scheduled-transactions.service.ts",
    reason:
      "Same shape for a scheduled posting: the last resort before refusing " +
      "to post an occurrence. The read is bounded by `getLatestRate`'s " +
      "default of FX_MAX_RATE_AGE_DAYS; moving it onto a dated lookup is a " +
      "posting-policy decision, not one made in a guard.",
  },
  {
    file: "strategies/gem-position.service.ts",
    reason:
      "GEM position valuation converts at the latest rate, bounded to the " +
      "same fortnight as its prices, in one call that resolves either stored " +
      "direction. The GEM surfaces have their own missing-data contract " +
      "(docs/security-benchmark-comparison.md) and moving them onto a dated " +
      "lookup is a separate change.",
  },
];

const LATEST_RATE_CALL = /\bgetLatestRate\s*\(/;
const RATE_ORDER_DESC = /(?:rateDate|rate_date)["'\s]*[,:]?\s*["']?DESC/;
const SINGLE_ROW =
  /\bfindOne\b|\.take\(1\)|\.limit\(1\)|LIMIT\s+1|DISTINCT ON|ROW_NUMBER\s*\(/;
/** How many lines either side of an ordering count as the same statement. */
const WINDOW = 12;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "dist"
        ? []
        : sourceFiles(full);
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

function findOffenders(): string[] {
  const offenders = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (DOOR_FILES.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    const exempt = doorMemberLines(rel, lines);
    lines.forEach((line, index) => {
      if (exempt.has(index)) return;
      if (LATEST_RATE_CALL.test(line)) {
        offenders.add(rel);
        return;
      }
      if (!RATE_ORDER_DESC.test(line)) return;
      const window = lines
        .slice(Math.max(0, index - WINDOW), index + WINDOW + 1)
        .join("\n");
      if (SINGLE_ROW.test(window)) offenders.add(rel);
    });
  }
  return [...offenders].sort();
}

describe("one door for a rate-for-a-date", () => {
  const offenders = findOffenders();

  it("finds source files to scan", () => {
    expect(sourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it("has no newest-rate read outside the resolver and the recorded baseline", () => {
    const allowed = new Set(BASELINE.map((entry) => entry.file));
    expect(offenders.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const found = new Set(offenders);
    expect(
      BASELINE.map((entry) => entry.file)
        .filter((file) => !found.has(file))
        .sort(),
    ).toEqual([]);
  });

  it("exempts only the declaration a door member owns, not its file", () => {
    for (const member of DOOR_MEMBERS) {
      const lines = readFileSync(join(SRC_ROOT, member.file), "utf8").split(
        "\n",
      );
      const covered = doorMemberLines(member.file, lines);
      expect(covered.size).toBeGreaterThan(0);
      // A slice of one member, not the file: the rest stays scanned.
      expect(covered.size).toBeLessThan(lines.length / 2);
      expect(member.reason.length).toBeGreaterThan(30);
    }
  });

  it("would flag a new unbounded read added beside the exempt member", () => {
    const service = "currencies/exchange-rate.service.ts";
    const lines = readFileSync(join(SRC_ROOT, service), "utf8").split("\n");
    const withNewRead = [
      ...lines,
      "  async somethingNew() {",
      "    return this.getLatestRate(from, to);",
      "  }",
    ];
    const exempt = doorMemberLines(service, withNewRead);
    const flagged = withNewRead.some(
      (line, index) => !exempt.has(index) && LATEST_RATE_CALL.test(line),
    );
    expect(flagged).toBe(true);
  });

  it("every baseline entry states why it is tolerated", () => {
    for (const entry of BASELINE) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });

  it("recognises the shapes it bans", () => {
    expect(LATEST_RATE_CALL.test("await this.rates.getLatestRate(a, b)")).toBe(
      true,
    );
    // The plural admin listing is a list, not a value-for-a-date.
    expect(LATEST_RATE_CALL.test("await this.rates.getLatestRates()")).toBe(
      false,
    );
    expect(RATE_ORDER_DESC.test('order: { rateDate: "DESC" }')).toBe(true);
    expect(RATE_ORDER_DESC.test("ORDER BY er.rate_date DESC")).toBe(true);
  });
});
