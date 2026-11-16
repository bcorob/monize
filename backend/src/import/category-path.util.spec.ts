import { splitCategoryPath } from "./category-path.util";

describe("splitCategoryPath", () => {
  it("returns one segment per level, root first", () => {
    expect(splitCategoryPath("Housing:Mortgage:Interest")).toEqual([
      "Housing",
      "Mortgage",
      "Interest",
    ]);
    expect(splitCategoryPath("A:B:C:D")).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps a top-level name whole", () => {
    expect(splitCategoryPath("Groceries")).toEqual(["Groceries"]);
  });

  it("trims each segment so spaced and unspaced paths name the same chain", () => {
    expect(splitCategoryPath(" Housing : Mortgage: Interest ")).toEqual(
      splitCategoryPath("Housing:Mortgage:Interest"),
    );
  });

  it("drops blank segments", () => {
    expect(splitCategoryPath("Housing::Interest:")).toEqual([
      "Housing",
      "Interest",
    ]);
    expect(splitCategoryPath("")).toEqual([]);
    expect(splitCategoryPath(" : ")).toEqual([]);
  });
});
