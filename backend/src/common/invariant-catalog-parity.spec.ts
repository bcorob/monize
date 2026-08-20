import { readFileSync } from "fs";
import { join } from "path";

/**
 * The invariant catalog and the verification matrix must name the same set of
 * invariants.
 *
 * `docs/system-invariants.md` defines the IDs (its Index table) and
 * `docs/verification-contract.md` says, per ID, which kind of test each one
 * needs (its matrix). The two drift silently: an invariant added to the catalog
 * with no matrix row has no stated required-test kind, and a matrix row with no
 * catalog entry describes a claim nothing defines. That is exactly what happened
 * when INV-RECONCILE-001 was catalogued and enforced while the matrix had no row
 * for it -- prose could not catch it, so this scan does.
 *
 * Both documents write their IDs as the first cell of a table row (`| INV-... |`
 * in the Index, `| INV-... <description> |` in the matrix), so the same
 * line-anchored match reads both.
 *
 * The IDs are collected as a **list**, not a set, so a duplicated row is visible.
 * Set equality alone would pass a document that carried the same ID twice -- and
 * a duplicate matrix row is worse than a missing one, because the two copies can
 * disagree about the required-test classification and nothing says which the
 * reader should believe. So each document is first checked for duplicate rows,
 * then the de-duplicated sets are compared for one-to-one coverage.
 */
const DOCS = join(__dirname, "..", "..", "..", "docs");

function tableRowInvariantIdList(file: string): string[] {
  const text = readFileSync(join(DOCS, file), "utf8");
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*(INV-[A-Z]+-\d+)\b/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    else seen.add(id);
  }
  return [...repeated].sort();
}

describe("the invariant catalog and the verification matrix cover the same IDs", () => {
  const catalogList = tableRowInvariantIdList("system-invariants.md");
  const matrixList = tableRowInvariantIdList("verification-contract.md");
  const catalog = new Set(catalogList);
  const matrix = new Set(matrixList);

  it("reads a plausible number of invariants from each document", () => {
    // A parsing regression (a reformatted table) would empty one list and make
    // the parity checks below pass vacuously; anchor them against reality.
    expect(catalog.size).toBeGreaterThan(20);
    expect(matrix.size).toBeGreaterThan(20);
  });

  it("has no invariant catalogued twice", () => {
    expect(duplicates(catalogList)).toEqual([]);
  });

  it("has no invariant in the verification matrix twice", () => {
    expect(duplicates(matrixList)).toEqual([]);
  });

  it("gives every catalogued invariant a verification-matrix row", () => {
    const missing = [...catalog].filter((id) => !matrix.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it("backs every verification-matrix row with a catalogued invariant", () => {
    const extra = [...matrix].filter((id) => !catalog.has(id)).sort();
    expect(extra).toEqual([]);
  });
});
