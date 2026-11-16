import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * Reading a security's two most recent closes and subtracting them is the whole
 * of a "daily change", and it is wrong on its own twice over: the pair may not
 * be adjacent sessions, and the newer close may not be the session the reader
 * is in. The second is the one that shipped -- a holding whose price row did
 * not land reported the previous session's move as today's, every day, on the
 * Top Movers widget and the favourite-securities widget alike, because both
 * wrote the same three lines of arithmetic for themselves.
 *
 * `daily-change.util.ts` is where the two rules live now. The mistake is
 * mechanical -- it is a SQL shape followed by a subtraction -- so it gets a
 * scanning test rather than a paragraph: a file that pulls the two most recent
 * prices per security has to resolve the change through the helper.
 */
const PER_SECURITY_PRICE_WINDOW =
  /ROW_NUMBER\(\)\s*OVER\s*\(PARTITION BY security_id ORDER BY price_date DESC\)/;
const RESOLVES_THROUGH_HELPER = /resolveDailyPriceChange/;

/**
 * The helper itself, which has no query in it, and the file that owns the
 * window function's other use. Empty of exemptions on purpose: a new reader of
 * the two-most-recent window is a new daily change, and the fix is to call the
 * helper rather than to add a name here.
 */
const ALLOWED = new Set<string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("a daily change is resolved in one place", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no file pulling a security's recent closes without the helper", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!PER_SECURITY_PRICE_WINDOW.test(source)) continue;
      if (RESOLVES_THROUGH_HELPER.test(source)) continue;
      // The failure names the fix: two closes are a daily move only while they
      // are adjacent sessions and the newer one is current, and
      // `securities/daily-change.util.ts` is what decides both.
      offenders.push(`${rel} -- call resolveDailyPriceChange`);
    }

    expect(offenders).toEqual([]);
  });

  it("still finds the readers, so the rule cannot pass over an empty sweep", () => {
    const readers = files.filter((file) =>
      PER_SECURITY_PRICE_WINDOW.test(readFileSync(file, "utf8")),
    );

    expect(readers.length).toBeGreaterThan(0);
  });

  it("recognises the query shape it scans for, and reads prose as prose", () => {
    expect(
      PER_SECURITY_PRICE_WINDOW.test(
        "ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn",
      ),
    ).toBe(true);
    // A window over something else, or over another ordering, is not the
    // two-most-recent-closes read this rule is about.
    expect(
      PER_SECURITY_PRICE_WINDOW.test(
        "ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY price_date DESC)",
      ),
    ).toBe(false);
  });
});
