import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import {
  plBenchmarks,
  plCalendar,
  POLISH_BOND_ADAPTER,
  registerPolishCalendars,
} from ".";
import { TRACKED_PROVIDERS } from "../../../provider-health/providers";

describe("Polish adapter", () => {
  it("registers the calendar under its id", () => {
    const registry = registerPolishCalendars(EMPTY_CALENDAR_REGISTRY);
    expect(registry.get("PL")).toBe(plCalendar);
    expect(EMPTY_CALENDAR_REGISTRY.size).toBe(0);
  });

  it("defines the two benchmark series with their publishers", () => {
    expect(plBenchmarks).toEqual([
      { id: "PL_NBP_REFERENCE", kind: "STEP", publisher: "NBP" },
      { id: "PL_CPI_GUS_YOY", kind: "MONTHLY", publisher: "GUS" },
    ]);
  });

  it("names the tracked provider its series fetch is gated under, and offers every series member", () => {
    expect(POLISH_BOND_ADAPTER.seriesProviderId).toBe("obligacjeskarbowe");
    expect(Object.keys(TRACKED_PROVIDERS)).toContain(
      POLISH_BOND_ADAPTER.seriesProviderId,
    );
    expect(POLISH_BOND_ADAPTER.fetchSeries).toEqual(expect.any(Function));
    expect(POLISH_BOND_ADAPTER.manualSeries).toEqual(expect.any(Function));
    expect(POLISH_BOND_ADAPTER.currentSeries).toEqual(expect.any(Function));
  });

  it("names the series sold on a date from its own grammar, null for what it does not sell", () => {
    const code = POLISH_BOND_ADAPTER.seriesCodeFor;
    expect(code?.("EDO", "2026-10-15")).toBe("EDO1036");
    expect(code?.("OTS", "2026-11-03")).toBe("OTS0227");
    expect(code?.("COI", "2026-12-31")).toBe("COI1230");
    expect(code?.("ROD", "2026-10-01")).toBe("ROD1038");
    expect(code?.("XYZ", "2026-10-15")).toBeNull();
    expect(code?.("toString", "2026-10-15")).toBeNull();
    expect(code?.("EDO", "2026-13-01")).toBeNull();
    expect(code?.("EDO", "nonsense")).toBeNull();
  });
});
