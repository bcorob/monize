/**
 * Every row written to `exchange_rates` is oriented by one helper.
 *
 * The table used to hold two rows per pair and date, the fetched direction and a
 * synthesised inverse, because two readers asked a direction-specific question.
 * Nothing kept the two reciprocal: a writer that touched one side only left a
 * pair whose rows disagreed about one date, and `resolveFxRate` picks the more
 * recently observed direction, so which figure a date resolved to depended on
 * which row happened to be newer. The Money importer was exactly such a writer.
 *
 * One orientation per pair removes the class. The rule is mechanical -- it is
 * about the shape of a write, not about a judgement a reviewer has to make on
 * each one -- so it is held here rather than in a paragraph: a third writer, or
 * one of the two that stops calling the helper, fails this scan
 * (`docs/specs/exchange-rate-canonical-orientation.md`, INV-FX-003).
 *
 * Reads are not restricted. A reader asks for a pair in whichever direction its
 * caller cares about and `resolveFxRate` resolves it; that is the point of the
 * collapse, not something to police.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");

/**
 * The files allowed to write the table, each with the reason it is a writer at
 * all. Shrink-only in spirit: a new entry is a new writer, which is the thing
 * this scan exists to notice.
 */
const WRITE_ALLOWLIST: Readonly<Record<string, string>> = {
  "currencies/exchange-rate.service.ts":
    "the provider writers -- saveRate for the daily refresh and " +
    "persistRateSeries for a fetched window; both orient through " +
    "canonicalRateRow before the upsert",
  "import/mny/writers/write-prices.ts":
    "the Money importer, which records whichever orientation the user entered " +
    "and canonicalises it in resolveExchangeRates before a bulk insert that " +
    "only fills dates the table holds nothing for (INV-FX-004)",
};

/** The helper every writer must reach for. */
const HELPER = "canonicalRateRow";

const WRITE_PATTERN = /INSERT\s+INTO\s+exchange_rates\b/i;

/**
 * Comments blanked, line count preserved, so the prose above -- which has to
 * name the very statement this scan looks for -- cannot trip it, and an offender
 * report still points at the right line.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "dist"
        ? []
        : sourceFiles(full);
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

/** `relative path -> its comment-free source`, for every file that writes. */
function writers(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (!WRITE_PATTERN.test(code)) continue;
    found.set(path.relative(SRC, file).split(path.sep).join("/"), code);
  }
  return found;
}

describe("one orientation for a stored exchange rate", () => {
  const found = writers();

  it("finds source files to scan", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it("has no writer of exchange_rates outside the reviewed two", () => {
    const allowed = new Set(Object.keys(WRITE_ALLOWLIST));
    const offenders = [...found.keys()].filter((file) => !allowed.has(file));

    // A new writer decides an orientation of its own, which is how the pair
    // stopped being reciprocal. Route it through `canonicalRateRow` and add it
    // here with the reason it is a separate writer.
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist shrink-only: every entry still writes", () => {
    const stale = Object.keys(WRITE_ALLOWLIST)
      .filter((file) => !found.has(file))
      .sort();

    expect(stale).toEqual([]);
  });

  it("orients every write through canonicalRateRow", () => {
    const unoriented = [...found.entries()]
      .filter(([, code]) => !code.includes(HELPER))
      .map(([file]) => file)
      .sort();

    // The statement is there and the helper is not: the row's orientation is
    // whatever the provider or the file happened to record.
    expect(unoriented).toEqual([]);
  });

  it("states why each allowed writer is one", () => {
    for (const reason of Object.values(WRITE_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it("recognises the shapes it looks for", () => {
    const withHelper = [
      "const row = canonicalRateRow(from, to, rate);",
      "await m.query(`INSERT INTO exchange_rates (from_currency) VALUES ($1)`);",
    ].join("\n");
    const withoutHelper =
      "await m.query(`INSERT INTO exchange_rates (from_currency) VALUES ($1)`);";

    expect(WRITE_PATTERN.test(withHelper)).toBe(true);
    expect(withHelper.includes(HELPER)).toBe(true);
    // The same statement with no helper in the file is what fails.
    expect(WRITE_PATTERN.test(withoutHelper)).toBe(true);
    expect(withoutHelper.includes(HELPER)).toBe(false);
    // A read is not a write.
    expect(
      WRITE_PATTERN.test("SELECT rate FROM exchange_rates WHERE ..."),
    ).toBe(false);
  });

  it("cannot be tripped or satisfied by prose", () => {
    const commentedWrite = "// INSERT INTO exchange_rates (from_currency)";
    const commentedHelper = [
      "/* canonicalRateRow decides the orientation. */",
      "await m.query(`INSERT INTO exchange_rates (from_currency) VALUES ($1)`);",
    ].join("\n");

    expect(WRITE_PATTERN.test(stripComments(commentedWrite))).toBe(false);
    // A block comment naming the helper does not satisfy the orientation check.
    const stripped = stripComments(commentedHelper);
    expect(WRITE_PATTERN.test(stripped)).toBe(true);
    expect(stripped.includes(HELPER)).toBe(false);
    // Line numbers survive the blanking, so an offender report stays accurate.
    expect(stripComments("/* a\nb */\ncode").split("\n")).toHaveLength(3);
  });
});
