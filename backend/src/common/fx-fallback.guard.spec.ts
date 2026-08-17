import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

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

/**
 * A silent currency-conversion fallback is a one-token mistake, so it gets a
 * scan rather than a paragraph.
 *
 * Audit finding P5-009: two conversion paths turned "no rate available" into
 * "rate 1.0" -- `return result ?? amount` and
 * `rate = reverseRate !== null ? 1 / reverseRate : 1`. 1,000 USD reported into
 * a EUR total came out as 1,000 EUR, an 11% overstatement that is numerically
 * plausible, and nothing in the response distinguished it from a genuine 1:1.
 *
 * The rule: a conversion returns `null` when it has no rate, and callers
 * accumulate through `FxAggregate`. Rate 1 is reachable only when the source
 * and destination currency codes are equal. See
 * `docs/specs/fx-conversion-completeness.md`.
 */
describe("currency conversion has no silent identity fallback", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never falls back from a failed conversion to the input amount", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `?? amount`, `|| amount`, `?? value` right where a conversion result
        // is consumed -- the exact shape of the removed defect.
        if (/(\?\?|\|\|)\s*(amount|rawValue|value)\s*;?\s*$/.test(line)) {
          const context = lines
            .slice(Math.max(0, index - 6), index + 1)
            .join("\n");
          if (/convert|Convert|rate|Rate/.test(context)) {
            offenders.push(`${rel}:${index + 1}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never defaults a missing exchange rate to 1", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `rate = ... : 1`, `rate ?? 1`, `rate || 1` -- assigning 1 as the
        // answer for a pair whose rate could not be found. A literal 1 for the
        // same-currency case is fine and does not match: it is not assigned to
        // a variable named for a rate out of a failed lookup.
        const assignsOneToRate =
          /\brate\w*\s*=\s*[^;]*[?:]\s*1\s*;/i.test(line) ||
          /\brate\w*\s*(\?\?|\|\|)\s*1\b/i.test(line);
        if (assignsOneToRate) offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("reciprocates a reverse rate only in reviewed places", () => {
    // "Try direct, then try the reverse and reciprocate" is the shape that has
    // to end in `null` when neither exists -- three copies of it ended in `1`
    // instead. Reciprocating is legitimate; doing it in a new place without
    // deciding what happens when there is no rate is not.
    //
    // Adding a file here is a reviewed decision: confirm the branch returns
    // null (or a typed unknown) rather than 1 before doing it.
    const allowed = new Set([
      // The shared date-aware helper -- the single direct/inverse decision.
      "common/currency-conversion.util.ts",
      // Persists the inverse pair alongside the direct one, at rate precision.
      "currencies/exchange-rate.service.ts",
      // Latest-rate resolvers, each returning null when the pair is unknown.
      "securities/portfolio-calculation.service.ts",
      "investment-reports/investment-report-data.service.ts",
      "strategies/gem-position.service.ts",
    ]);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (allowed.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (/1\s*\/\s*(reverse|inverse)\w*/i.test(source)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("every reviewed reciprocal returns null when neither direction exists", () => {
    // The allowlist above is only meaningful if the files on it actually
    // handle the absent case. Each must mention returning null near its
    // reciprocal rather than falling through to a number.
    const resolvers = [
      "securities/portfolio-calculation.service.ts",
      "investment-reports/investment-report-data.service.ts",
      "strategies/gem-position.service.ts",
    ];

    for (const rel of resolvers) {
      const source = readFileSync(join(SRC_ROOT, rel), "utf8");
      const idx = source.search(/1\s*\/\s*(reverse|inverse)\w*/i);
      expect(idx).toBeGreaterThan(-1);
      // Look at the surrounding block for the null-return decision.
      const around = source.slice(Math.max(0, idx - 400), idx + 200);
      expect(around).toMatch(/null/);
    }
  });
});
