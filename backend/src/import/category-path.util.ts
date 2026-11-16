/**
 * The levels of a colon-delimited category path, root first:
 * `"Housing:Mortgage:Interest"` -> `["Housing", "Mortgage", "Interest"]`.
 *
 * QIF (and QMTF, which is QIF under another extension) separates every level
 * with a colon, and the CSV importer joins its category and subcategory
 * columns the same way. Quicken budgets three and four levels deep, so each
 * segment becomes its own category under the one before it; splitting at the
 * first colon only would file "Mortgage:Interest" as a single child and lose
 * the roll-up at "Mortgage". Segments are trimmed and blank ones dropped, so
 * `"Housing: Mortgage"` and `"Housing:Mortgage"` name the same chain.
 */
export function splitCategoryPath(path: string): string[] {
  return path
    .split(":")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}
