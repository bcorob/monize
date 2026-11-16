import { requestContextStorage } from "../../../common/request-context";
import { simplefinWindows } from "./simplefin.windows";

describe("SimpleFIN local-day coverage", () => {
  it.each(["2026-03-08", "2026-11-01"])(
    "covers local endpoints across DST on %s",
    (day) => {
      const windows = requestContextStorage.run(
        { timezone: "America/Toronto" },
        () => simplefinWindows(day, day),
      );
      expect(windows[0].startDate).toBeLessThan(
        Date.parse(day + "T05:00:00Z") / 1000,
      );
      expect(windows[windows.length - 1].endDate).toBeGreaterThan(
        Date.parse(day + "T23:59:59Z") / 1000,
      );
      for (const window of windows)
        expect(window.endDate - window.startDate).toBeLessThanOrEqual(
          45 * 86400,
        );
    },
  );
  it("keeps exclusive-end windows contiguous with local-day padding", () => {
    const windows = requestContextStorage.run({ timezone: "Asia/Tokyo" }, () =>
      simplefinWindows("2026-01-01", "2026-12-31"),
    );
    for (let i = 1; i < windows.length; i++)
      expect(windows[i - 1].endDate).toBe(windows[i].startDate);
  });
});
