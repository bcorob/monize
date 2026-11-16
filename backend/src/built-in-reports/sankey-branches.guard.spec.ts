import { readFileSync } from "fs";
import { join } from "path";

/**
 * SANKEY-003: investment linkage and VOID are excluded on EVERY branch of the
 * Cash Flow Sankey -- the categorized rows and both transfer-leg shapes.
 *
 * `investment-filter.guard.spec.ts` already reads every built-in-report
 * query, but it exempts a transfer-only query (an investment cash leg is never
 * a transfer). The Sankey reads transfer legs as flows, so a BUY's cash leg
 * posted as a transfer would land in "Savings & investments" if a transfer
 * branch dropped the exclusion; this guard holds the stricter rule for the
 * Sankey's own query builders, the INV-REPORT-001 guard pattern applied to
 * each branch.
 */
const SERVICE = join(__dirname, "cash-flow-sankey.service.ts");

/** Every `export function <name>Query(...)` body, by name. */
export function queryBuilders(source: string): Map<string, string> {
  const builders = new Map<string, string>();
  const header = /export function (\w+Query)\(/g;
  const starts: Array<{ name: string; index: number }> = [];
  for (const match of source.matchAll(header)) {
    starts.push({ name: match[1], index: match.index ?? 0 });
  }
  for (const [position, start] of starts.entries()) {
    const end =
      position + 1 < starts.length ? starts[position + 1].index : undefined;
    // The last builder runs to the next top-level declaration.
    const rest = source.slice(start.index, end);
    const cut =
      end === undefined
        ? rest.search(/\n(?:interface|const|@Injectable|export class) /)
        : -1;
    builders.set(start.name, cut > 0 ? rest.slice(0, cut) : rest);
  }
  return builders;
}

/** What a builder is missing of the two exclusions. */
export function missingExclusions(body: string): string[] {
  const missing: string[] = [];
  if (!/\$\{INVESTMENT_EXCLUSION(?:_NO_SPLITS)?\}/.test(body)) {
    missing.push("investmentExclusionSql");
  }
  if (!body.includes("(t.status IS NULL OR t.status != 'VOID')")) {
    missing.push("the VOID predicate");
  }
  // A builder that joins split rows needs the split-aware form.
  if (
    /JOIN transaction_splits/.test(body) &&
    !/\$\{INVESTMENT_EXCLUSION\}/.test(body)
  ) {
    missing.push("the split-aware INVESTMENT_EXCLUSION");
  }
  return missing;
}

describe("every Cash Flow Sankey branch excludes investment linkage and VOID (SANKEY-003)", () => {
  const source = readFileSync(SERVICE, "utf8");
  const builders = queryBuilders(source);

  it("finds the categorized and both transfer-leg builders", () => {
    expect([...builders.keys()].sort()).toEqual([
      "categorizedRowsQuery",
      "splitTransferLegsQuery",
      "wholeTransferLegsQuery",
    ]);
  });

  it("applies both exclusions in each builder", () => {
    const failures = [...builders.entries()]
      .map(([name, body]) => ({ name, missing: missingExclusions(body) }))
      .filter((entry) => entry.missing.length > 0)
      .map((entry) => `${entry.name}: missing ${entry.missing.join(", ")}`);

    expect(failures).toEqual([]);
  });

  it("builds the exclusion constants from the shared helper", () => {
    expect(source).toMatch(
      /const INVESTMENT_EXCLUSION = investmentExclusionSql\(/,
    );
    expect(source).toMatch(
      /const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql\(/,
    );
  });

  it("runs every builder it declares", () => {
    for (const name of builders.keys()) {
      expect(source).toMatch(new RegExp(`= ${name}\\(scope\\)`));
    }
  });
});

describe("the Sankey branch scan fires", () => {
  it("flags a builder without the investment exclusion", () => {
    expect(
      missingExclusions(
        "FROM transactions t WHERE (t.status IS NULL OR t.status != 'VOID')",
      ),
    ).toEqual(["investmentExclusionSql"]);
  });

  it("flags a builder without the VOID predicate", () => {
    expect(
      missingExclusions("FROM transactions t WHERE ${INVESTMENT_EXCLUSION}"),
    ).toEqual(["the VOID predicate"]);
  });

  it("flags a split-joining builder that downgrades to the no-splits form", () => {
    expect(
      missingExclusions(
        "FROM transactions t JOIN transaction_splits ts ON true WHERE ${INVESTMENT_EXCLUSION_NO_SPLITS} AND (t.status IS NULL OR t.status != 'VOID')",
      ),
    ).toEqual(["the split-aware INVESTMENT_EXCLUSION"]);
  });

  it("separates builders so one's exclusion cannot cover another", () => {
    const planted = [
      "export function aQuery(scope) { return `${INVESTMENT_EXCLUSION} (t.status IS NULL OR t.status != 'VOID')`; }",
      "export function bQuery(scope) { return `FROM transactions t`; }",
      "interface Tail {}",
    ].join("\n");

    const builders = queryBuilders(planted);

    expect(missingExclusions(builders.get("aQuery")!)).toEqual([]);
    expect(missingExclusions(builders.get("bQuery")!)).toEqual([
      "investmentExclusionSql",
      "the VOID predicate",
    ]);
  });
});
