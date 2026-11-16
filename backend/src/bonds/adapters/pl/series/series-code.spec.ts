import { SeriesFetchError } from "../../../bond-adapter";
import { parseSeriesCode } from "./series-code";

describe("parseSeriesCode", () => {
  it.each([
    ["OTS0127", "OTS", "2026-10", "2026-10-31"],
    ["ROR1027", "ROR", "2026-10", "2026-10-31"],
    ["DOR1028", "DOR", "2026-10", "2026-10-31"],
    ["TOS1029", "TOS", "2026-10", "2026-10-31"],
    ["COI1030", "COI", "2026-10", "2026-10-31"],
    ["ROS1032", "ROS", "2026-10", "2026-10-31"],
    ["EDO1036", "EDO", "2026-10", "2026-10-31"],
    ["ROD1038", "ROD", "2026-10", "2026-10-31"],
    ["EDO0934", "EDO", "2024-09", "2024-09-30"],
    ["ROR0225", "ROR", "2024-02", "2024-02-29"],
  ])("reads %s", (code, product, saleMonth, lastDay) => {
    const parsed = parseSeriesCode(code);
    expect(parsed.product).toBe(product);
    expect(parsed.saleMonth).toBe(saleMonth);
    expect(parsed.saleWindow).toEqual({ from: `${saleMonth}-01`, to: lastDay });
  });

  it("accepts lower case and surrounding spaces, and returns the upper-case code", () => {
    expect(parseSeriesCode(" edo1036 ").code).toBe("EDO1036");
  });

  it.each([
    "EDO0036",
    "EDO1336",
    "EDO10",
    "EDO10361",
    "XYZ1036",
    "",
    "E1D1036",
    "EDO10-6",
  ])("refuses %p", (code) => {
    expect(() => parseSeriesCode(code)).toThrow(SeriesFetchError);
    try {
      parseSeriesCode(code);
    } catch (error) {
      expect((error as SeriesFetchError).code).toBe("SERIES_CODE_INVALID");
    }
  });

  it("refuses a value that is not a string and echoes no free text", () => {
    expect.assertions(2);
    expect(() => parseSeriesCode(42)).toThrow(SeriesFetchError);
    try {
      parseSeriesCode("<script>x</script>");
    } catch (error) {
      expect((error as SeriesFetchError).params.seriesCode).toBe("");
    }
  });
});
