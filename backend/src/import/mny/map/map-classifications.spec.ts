import {
  mnyCategory,
  mnyClassification,
  mnyTransaction,
  referenceData,
} from "../__fixtures__/mny-row-builders";
import {
  MAX_TAG_NAME_LENGTH,
  mapClassificationTags,
  transactionTagHandles,
} from "./map-classifications";

/**
 * Money's two classifications become Monize tags under the `key:value`
 * convention. The shape is pinned from the maintainer's file: one `CT` row
 * (`hct` 1, "Properties") and one top-level item in `CAT` (`hcat` 552,
 * `hct` 1, `nLevel` 0, no parent), referenced by 67 rows through `lHcls1`.
 */

const PROPERTIES = mnyClassification({ handle: 1, name: "Properties" });
const APARTMENT = mnyCategory({
  handle: 552,
  name: "20 Spring Apartment",
  level: 0,
  parent: null,
  classification: 1,
  categoryType: -1,
});
const EXPENSE_ROOT = mnyCategory({
  handle: 131,
  name: "EXPENSE",
  level: 0,
  parent: null,
  categoryType: -1,
});
const GROCERIES = mnyCategory({
  handle: 200,
  name: "Groceries",
  level: 1,
  parent: 131,
});

function reference(
  categories = [EXPENSE_ROOT, GROCERIES, APARTMENT],
  classifications = [PROPERTIES],
) {
  return referenceData({ categories, classifications });
}

describe("transactionTagHandles", () => {
  it("reads both classification slots and drops the empty ones", () => {
    expect(transactionTagHandles(mnyTransaction())).toEqual([]);
    expect(
      transactionTagHandles(mnyTransaction({ classification1: 552 })),
    ).toEqual([552]);
    expect(
      transactionTagHandles(
        mnyTransaction({ classification1: 552, classification2: 700 }),
      ),
    ).toEqual([552, 700]);
  });
});

describe("mapClassificationTags", () => {
  it("names a referenced item <classification>:<item>", () => {
    const result = mapClassificationTags(reference(), new Set([552]));

    expect(result.tags).toEqual([
      { handle: 552, name: "Properties:20 Spring Apartment" },
    ]);
    expect(result.byHandle.get(552)?.name).toBe(
      "Properties:20 Spring Apartment",
    );
    expect(result.inFile).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("keeps a nested item's path, which the key:value convention reads as the value", () => {
    const kitchen = mnyCategory({
      handle: 553,
      name: " Kitchen ",
      level: 1,
      parent: 552,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, APARTMENT, kitchen]),
      new Set([553]),
    );

    expect(result.tags.map((tag) => tag.name)).toEqual([
      "Properties:20 Spring Apartment:Kitchen",
    ]);
  });

  it("falls back to the item path when the file has no CT row for the classification", () => {
    const result = mapClassificationTags(
      reference(undefined, []),
      new Set([552]),
    );

    expect(result.tags.map((tag) => tag.name)).toEqual(["20 Spring Apartment"]);
  });

  it("creates tags only for referenced items and counts the rest as skipped", () => {
    const cottage = mnyCategory({
      handle: 560,
      name: "Cottage",
      level: 0,
      parent: null,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, GROCERIES, APARTMENT, cottage]),
      new Set([552]),
    );

    expect(result.tags.map((tag) => tag.handle)).toEqual([552]);
    expect(result.inFile).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("keeps a blank-named item importable under a placeholder, rather than calling it undefined", () => {
    const blank = mnyCategory({
      handle: 570,
      name: "   ",
      level: 0,
      parent: null,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, blank]),
      new Set([570]),
    );

    expect(result.tags.map((tag) => tag.name)).toEqual(["Properties:Item 570"]);
    expect(result.inFile).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("never turns an ordinary category into a tag, and reports the reference", () => {
    // `lHcls1` pointing at a category-tree row is a damaged file, not a tag.
    const result = mapClassificationTags(reference(), new Set([200, 999]));

    expect(result.tags).toEqual([]);
    expect(result.warnings).toEqual([
      { code: "unknownClassificationItem", subject: "hcat=200" },
      { code: "unknownClassificationItem", subject: "hcat=999" },
    ]);
  });

  it("merges items whose names differ only in case onto one tag, mapping both handles", () => {
    // `idx_tags_user_name` is unique on LOWER(name); two tags cannot exist.
    const lower = mnyCategory({
      handle: 561,
      name: "20 spring apartment",
      level: 0,
      parent: null,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, APARTMENT, lower]),
      new Set([552, 561]),
    );

    expect(result.tags).toHaveLength(1);
    expect(result.byHandle.get(561)).toBe(result.byHandle.get(552));
  });

  it("clamps a name to the tags.name column width", () => {
    const long = mnyCategory({
      handle: 562,
      name: "x".repeat(200),
      level: 0,
      parent: null,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, long]),
      new Set([562]),
    );

    expect(result.tags[0].name).toHaveLength(MAX_TAG_NAME_LENGTH);
    expect(result.tags[0].name.startsWith("Properties:xxx")).toBe(true);
  });

  it("trims a clamped name, so what TagsService stores still matches the handle", () => {
    // `TagsService` trims before writing; a name cut at a space would come back
    // one character shorter than asked for and resolve to no handle.
    const cutAtSpace = mnyCategory({
      handle: 563,
      name: `${"y".repeat(MAX_TAG_NAME_LENGTH - "Properties:".length - 1)} tail`,
      level: 0,
      parent: null,
      classification: 1,
    });
    const result = mapClassificationTags(
      reference([EXPENSE_ROOT, cutAtSpace]),
      new Set([563]),
    );

    expect(result.tags[0].name).toHaveLength(MAX_TAG_NAME_LENGTH - 1);
    expect(result.tags[0].name.endsWith("y")).toBe(true);
  });

  it("does not spin on a cyclic parent chain", () => {
    const a = mnyCategory({
      handle: 570,
      name: "A",
      level: 1,
      parent: 571,
      classification: 1,
    });
    const b = mnyCategory({
      handle: 571,
      name: "B",
      level: 1,
      parent: 570,
      classification: 1,
    });

    const [tag] = mapClassificationTags(reference([a, b]), new Set([570])).tags;

    expect(tag.name.startsWith("Properties:")).toBe(true);
    expect(tag.name.endsWith(":A")).toBe(true);
  });
});
