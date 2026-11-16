import { inflateSync } from "node:zlib";
import { renderPriceChart, CHART_WIDTH, CHART_HEIGHT } from "./price-chart-png";
const points = [
  { date: "2026-09-01", close: 100 },
  { date: "2026-09-07", close: 110 },
];
describe("price chart PNG", () => {
  it("emits a bounded RGB PNG with actual plotted pixels", () => {
    const png = renderPriceChart(points)!;
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(CHART_WIDTH);
    expect(png.readUInt32BE(20)).toBe(CHART_HEIGHT);
    const parts: Buffer[] = [];
    for (let i = 8; i < png.length;) {
      const length = png.readUInt32BE(i),
        type = png.toString("ascii", i + 4, i + 8);
      if (type === "IDAT") parts.push(png.subarray(i + 8, i + 8 + length));
      i += 12 + length;
    }
    const pixels = inflateSync(Buffer.concat(parts));
    expect(pixels.length).toBe((CHART_WIDTH * 3 + 1) * CHART_HEIGHT);
    expect(pixels.filter((v) => v === 37).length).toBeGreaterThan(200);
    expect(png.length).toBeLessThan(64 * 1024);
    expect(renderPriceChart(points)).toEqual(png);
  });
  it("handles a flat series", () =>
    expect(
      renderPriceChart(points.map((p) => ({ ...p, close: 100 }))),
    ).not.toBeNull());
  it.each(
    [
      [],
      points.slice(0, 1),
      Array.from({ length: 61 }, () => points[0]),
      [...points].reverse(),
      [points[0], points[0]],
      [{ ...points[0], date: "2026-02-30" }, points[1]],
      [{ ...points[0], close: NaN }, points[1]],
      [{ ...points[0], close: Infinity }, points[1]],
      [{ ...points[0], close: 0 }, points[1]],
      [{ ...points[0], close: 1e100 }, points[1]],
    ].map((input) => ({ input })),
  )("rejects invalid input", ({ input }) => {
    expect(renderPriceChart(input)).toBeNull();
  });
});
