import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/** The file that owns the label. Everything else has to call it. */
const OWNER = "securities/investment-cash-payee.util.ts";

/**
 * The three writers of an investment cash leg. Each must reach the label
 * through the util rather than assembling one, and the list is asserted in
 * both directions so a fourth producer is a decision somebody made here.
 */
const PRODUCERS = [
  "securities/investment-transactions.service.ts",
  "import/import-investment-processor.service.ts",
  "import/mny/writers/write-investments.ts",
];

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

function rel(file: string): string {
  return relative(SRC_ROOT, file).split("\\").join("/");
}

/**
 * A cash leg's payee label is the only thing on that row saying why the money
 * moved, and it was written out twice and omitted once. The QIF copy hard-coded
 * a `$` over an amount it had just converted out of the security's currency,
 * and the `.mny` writer wrote no label at all, so every imported trade's cash
 * leg rendered as "-" in the register (issue #1204).
 *
 * Each copy was internally consistent -- the same reason the duplicated share
 * replay survived -- so this is a scan rather than a paragraph.
 */
describe("the investment cash payee label is written once", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no second title-caser folding an investment action into prose", () => {
    // Narrow on purpose: the subject has to be an action. Title-casing some
    // other snake_case value (a security type, say) is not this mistake.
    const handRolled = /\b\w*[Aa]ction\w*\s*\.split\("_"\)/;
    const offenders = files
      .filter((file) => rel(file) !== OWNER)
      .filter((file) => handRolled.test(readFileSync(file, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("has no payee label built with a hard-coded currency symbol", () => {
    // `$${x.toFixed(2)}` is what the QIF importer wrote beside a converted
    // amount: right for a USD file and wrong for every other one.
    // Bounded to the assignment itself: a log line that happens to print a
    // payee beside a dollar amount is not this defect.
    const hardCoded = /payeeName\s*[:=][^;]{0,300}\$\$\{[^}]*toFixed\(/;
    const offenders = files
      .filter((file) => hardCoded.test(readFileSync(file, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("routes every cash-leg producer through the util, and names no others", () => {
    const callers = files
      .filter((file) => rel(file) !== OWNER)
      .filter((file) =>
        readFileSync(file, "utf8").includes("formatInvestmentCashPayeeName"),
      )
      .map(rel)
      .sort();

    expect(callers).toEqual([...PRODUCERS].sort());
  });
});
