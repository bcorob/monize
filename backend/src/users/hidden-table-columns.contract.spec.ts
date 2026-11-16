import { readFileSync } from "fs";
import { join } from "path";
import {
  HIDDEN_COLUMN_TABLES,
  HIDEABLE_TABLE_COLUMNS,
} from "./hidden-table-columns";

/**
 * The hideable columns are ONE list per table kind, declared in two layers.
 *
 * Neither disagreement shows up in a type error. An id the browser offers and
 * the server does not know is a 400 on every save from the column menu, so the
 * user can hide nothing on that table. An id the server accepts and the
 * browser does not know is dropped on read, so it can be stored but never
 * shown or restored. The validator refuses rather than drops, so the browser's
 * list must be a subset; equal, in order, is the claim.
 *
 * The browser's copy cannot import the server's, so it is read as text here.
 */
const repoRoot = join(__dirname, "..", "..", "..");

describe("the hideable table columns", () => {
  it("are the same lists, in the same order, in both layers", () => {
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/hidden-columns.ts"),
      "utf8",
    );
    const declaration = frontend.match(
      /HIDEABLE_COLUMNS\s*=\s*\{([\s\S]*?)\}\s*as const/,
    );
    // Jest has no message argument on expect, so the shape this scan needs is
    // stated here instead: the frontend map must stay an `as const` object
    // literal of `kind: [quoted ids]` entries, or this guard stops covering it.
    expect(declaration).not.toBeNull();

    const entries = [
      ...declaration![1].matchAll(/([A-Za-z]+)\s*:\s*\[([\s\S]*?)\]/g),
    ].map(
      (entry) =>
        [
          entry[1],
          [...entry[2].matchAll(/["']([A-Za-z]+)["']/g)].map((id) => id[1]),
        ] as const,
    );

    expect(entries.map(([kind]) => kind)).toEqual([...HIDDEN_COLUMN_TABLES]);
    for (const [kind, ids] of entries) {
      expect({ kind, ids }).toEqual({
        kind,
        ids: [
          ...HIDEABLE_TABLE_COLUMNS[
            kind as keyof typeof HIDEABLE_TABLE_COLUMNS
          ],
        ],
      });
    }
  });
});
