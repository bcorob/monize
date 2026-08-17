import * as fs from "fs";
import * as path from "path";

/**
 * Every reader of investment_transactions decides whether it reads ROWS AS
 * RECORDS (VOID rows included -- lists, counts, delete guards, identity
 * checks) or ROWS AS EFFECTS (VOID rows excluded -- share replays, cost
 * basis, gains, valuations, cash projections). The decision is visible at the
 * query site: an effects reader references the shared predicate
 * (`NON_VOID_INVESTMENT_STATUS`, `investmentRowHasEffect`, or the SQL
 * fragment `status != 'VOID'`), a records reader says `includes VOID` in a
 * comment beside the query.
 *
 * This scan fails on a query site that does neither, so a new reader cannot
 * skip the decision -- the defect this prevents is a plausible total quietly
 * summing trades the user voided. docs/specs/investment-transaction-status.md
 * section 2, invariant 4.
 */

const BACKEND_SRC = path.join(__dirname, "..");

/** How far around the match the classification may sit (lines). */
const WINDOW = 20;

const QUERY_PATTERNS = [
  /from\s+investment_transactions/i,
  /getRepository\(InvestmentTransaction\)/,
  /\bfind\(InvestmentTransaction\b/,
  /\.count\(InvestmentTransaction\b/,
];

const CLASSIFICATION_MARKERS = [
  "NON_VOID_INVESTMENT_STATUS",
  "investmentRowHasEffect",
  "status != 'VOID'",
  "includes VOID",
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "entities") continue;
      out.push(...collectSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      // The predicate's own definitions are not query sites.
      entry.name !== "investment-row-effects.util.ts"
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("investment_transactions query-site classification", () => {
  it("classifies every query site as records (includes VOID) or effects (excludes VOID)", () => {
    const failures: string[] = [];

    for (const file of collectSourceFiles(BACKEND_SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!QUERY_PATTERNS.some((pattern) => pattern.test(line))) return;
        // A write is not a read: INSERT INTO / DELETE FROM sites move rows,
        // they do not aggregate them. (UPDATE ... FROM would still match the
        // read pattern and need a decision, which is intended.)
        if (/insert\s+into\s+investment_transactions/i.test(line)) return;
        if (/delete\s+from\s+investment_transactions/i.test(line)) return;

        const start = Math.max(0, index - WINDOW);
        const end = Math.min(lines.length, index + WINDOW + 1);
        const window = lines.slice(start, end).join("\n");
        if (CLASSIFICATION_MARKERS.some((m) => window.includes(m))) return;

        failures.push(
          `${path.relative(BACKEND_SRC, file)}:${index + 1}: ${line.trim()}`,
        );
      });
    }

    if (failures.length > 0) {
      throw new Error(
        `Unclassified investment_transactions query site(s). Decide whether ` +
          `each reads rows as records (add an "includes VOID" comment beside ` +
          `the query) or as effects (filter with NON_VOID_INVESTMENT_STATUS / ` +
          `investmentRowHasEffect / status != 'VOID'):\n${failures.join("\n")}`,
      );
    }
  });
});
