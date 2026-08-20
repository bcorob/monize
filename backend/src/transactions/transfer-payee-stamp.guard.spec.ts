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
 * A transfer's display payee is resolved at read time, never stamped at write
 * time (issue #1214).
 *
 * The old behaviour wrote `Transfer to <account>` / `Transfer from <account>`
 * into `payee_name` when a transfer was created with a blank payee, in SIX
 * separate places (transfer create, two edit-regeneration branches, the split
 * counterpart writer, and the QIF import's linked-leg writers). The text went
 * stale on account rename and could not follow the reader's language, and
 * migration 161 blanked the rows it produced. A seventh copy would quietly
 * reintroduce the class, so the English form of the label lives in exactly
 * one file -- `transfer-payee-label.util.ts` -- and this scan fails on a
 * template literal spelling it anywhere else in `src/`.
 */
describe("transfer payee labels are never hand-stamped", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("spells the Transfer to/from template literal only in transfer-payee-label.util.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (rel === "transactions/transfer-payee-label.util.ts") continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/`Transfer (?:to|from) \$\{/.test(line)) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
