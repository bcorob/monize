import { backfillCodes, SERIES_VALID_FROM } from "./backfill-codes";
import { parseSeriesCode, seriesCodeFor } from "./series-code";

describe("seriesCodeFor", () => {
  it.each([
    ["OTS", "2026-10", "OTS0127"],
    ["EDO", "2026-10", "EDO1036"],
    ["ROD", "2026-10", "ROD1038"],
    ["TOS", "2026-10", "TOS1029"],
    ["ROR", "2024-02", "ROR0225"],
    ["EDO", "2024-09", "EDO0934"],
    ["OTS", "2024-01", "OTS0424"],
    ["ROD", "2024-01", "ROD0136"],
  ] as const)("%s sold in %s is %s", (product, month, code) => {
    expect(seriesCodeFor(product, month)).toBe(code);
  });
});

describe("backfillCodes", () => {
  it("starts at the templates' validFrom", () => {
    expect(SERIES_VALID_FROM).toBe("2024-01");
  });

  it("derives one code per product and sale month from 2024-01 to the current month", () => {
    const codes = backfillCodes("2026-10-11");
    // 34 months x 8 products
    expect(codes).toHaveLength(34 * 8);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.slice(0, 8)).toEqual([
      "OTS0424",
      "ROR0125",
      "DOR0126",
      "TOS0127",
      "COI0128",
      "ROS0130",
      "EDO0134",
      "ROD0136",
    ]);
    expect(codes.slice(-8)).toEqual([
      "OTS0127",
      "ROR1027",
      "DOR1028",
      "TOS1029",
      "COI1030",
      "ROS1032",
      "EDO1036",
      "ROD1038",
    ]);
  });

  it("round-trips through the series-code grammar and never leaves the window", () => {
    for (const code of backfillCodes("2026-10-11")) {
      const { saleMonth } = parseSeriesCode(code);
      expect(saleMonth >= "2024-01" && saleMonth <= "2026-10").toBe(true);
    }
  });

  it("is empty before the first validated month", () => {
    expect(backfillCodes("2023-12-31")).toEqual([]);
  });
});
