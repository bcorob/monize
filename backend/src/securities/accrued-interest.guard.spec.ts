import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/** The file that owns the arithmetic. Everything else calls it. */
const ALLOWED = new Set(["securities/accrued-interest.util.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Proceeds and accrued interest are added in exactly one place.
 *
 * A redemption stores proceeds in `total_amount` and the interest on a linked
 * INTEREST companion, so the cash it moves is the sum -- and a second copy of
 * that sum is how the pair starts describing two different amounts of money.
 * The subtraction is guarded too: recovering proceeds from Money's gross
 * `TRN.amt` is the same rule facing the other way.
 */
describe("accrued interest arithmetic is written once", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no hand-rolled addition or subtraction of an accrued-interest value", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // An identifier ending in `accruedInterest` on either side of a `+` or
        // `-`. Assignments, comparisons and property reads are untouched; only
        // combining it with another money value is the mistake.
        const combines =
          /[+-]\s*[A-Za-z_$][\w$.?]*\.?accruedInterest\b/i.test(line) ||
          /\baccruedInterest\b[\w$.?]*\s*[+-]\s/i.test(line);
        if (combines) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
