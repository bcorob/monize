import { readFileSync } from "fs";
import { join } from "path";
import { TRANSACTION_SORT_FIELDS } from "./register-order";

/**
 * The register's sortable columns are ONE list, declared in two layers.
 *
 * They fail in two different directions when they disagree, and neither shows
 * up in a type error. A field the browser offers and the server does not is a
 * 400 behind a column header, on a click. A field the server accepts and the
 * browser omits is a column nobody can sort by -- and, because the sort is
 * remembered in the browser, a register that can be left sorted by a column
 * with no control to change it back.
 *
 * The tool schemas derive their enums from the server's copy in code, so they
 * need no check here; the browser's copy cannot import it, so it is checked.
 */
const repoRoot = join(__dirname, "..", "..", "..");

describe("the register's sortable columns", () => {
  it("are the same list, in the same order, in both layers", () => {
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/transaction-sort.ts"),
      "utf8",
    );
    const declaration = frontend.match(
      /TRANSACTION_SORT_FIELDS\s*=\s*\[([\s\S]*?)\]\s*as const/,
    );
    // Jest has no message argument on expect, so the shape this scan needs is
    // stated here instead: the frontend list must stay a `as const` array of
    // quoted names, or this guard stops covering it.
    expect(declaration).not.toBeNull();

    const declared = [...declaration![1].matchAll(/["']([A-Za-z]+)["']/g)].map(
      (match) => match[1],
    );
    expect(declared).toEqual([...TRANSACTION_SORT_FIELDS]);
  });
});
