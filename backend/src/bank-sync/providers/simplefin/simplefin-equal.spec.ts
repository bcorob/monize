import { simplefinEqual } from "./simplefin-equal";

describe("SimpleFIN string equality", () => {
  it.each([
    ["same", "same", true],
    ["same", "samt", false],
    ["short", "longer", false],
    ["", "", true],
    ["é", "e", false],
    ["é", "é", true],
  ])(
    "compares %p and %p without throwing on different byte lengths",
    (left, right, equal) => {
      expect(simplefinEqual(left, right)).toBe(equal);
    },
  );
});
