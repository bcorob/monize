import { ManualSeriesValues, SeriesFetchError } from "../../../bond-adapter";
import edo from "../fixtures/series/edo1036.terms.json";
import ots from "../fixtures/series/ots0127.terms.json";
import tos from "../fixtures/series/tos1029.terms.json";
import { POLISH_BOND_ADAPTER } from "..";
import { manualSeries } from "./manual-series";

const EDO_VALUES: ManualSeriesValues = {
  firstPeriodRate: "0.0535",
  addend: "0.0200",
  fee: "3.00",
  saleWindow: { from: "2026-10-01", to: "2026-10-31" },
  letter: { number: "99/2026", date: "2026-09-21" },
};

function failure(fn: () => unknown): SeriesFetchError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SeriesFetchError);
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
}

const withoutSource = (terms: unknown) => {
  const { source: _source, ...rest } = terms as Record<string, unknown>;
  return rest;
};

describe("manualSeries", () => {
  it("builds the curated terms from the template and the typed values", () => {
    const entry = manualSeries("edo1036", EDO_VALUES);
    expect(withoutSource(entry.terms)).toEqual(withoutSource(edo));
    expect(entry.termsVersion).toBe(1);
    expect(entry.publishedAt).toBe("2026-09-21");
    expect((entry.terms as { source: unknown }).source).toEqual({
      provider: "manual",
      url: "https://www.obligacjeskarbowe.pl/oferta-obligacji/obligacje-10-letnie-edo/edo1036/",
      document: "List emisyjny nr 99/2026",
    });
  });

  it("is what the Polish adapter exposes", () => {
    expect(
      POLISH_BOND_ADAPTER.manualSeries!("EDO1036", EDO_VALUES).termsVersion,
    ).toBe(1);
  });

  it("builds a fixed-rate series with no margin and no fee: OTS0127", () => {
    const entry = manualSeries("OTS0127", {
      firstPeriodRate: "0.02",
      addend: null,
      fee: null,
      saleWindow: { from: "2026-10-01", to: "2026-10-31" },
      letter: { number: "94/2026", date: "2026-09-21" },
    });
    expect(withoutSource(entry.terms)).toEqual(withoutSource(ots));
  });

  it("builds a fixed-rate series that has a fee: TOS1029", () => {
    const entry = manualSeries("TOS1029", {
      firstPeriodRate: "0.044",
      addend: null,
      fee: "1",
      saleWindow: { from: "2026-10-01", to: "2026-10-31" },
      letter: { number: "97/2026", date: "2026-09-21" },
    });
    expect(withoutSource(entry.terms)).toEqual(withoutSource(tos));
  });

  it("refuses a bad code and a series the template was not checked for", () => {
    expect(failure(() => manualSeries("EDO1336", EDO_VALUES)).code).toBe(
      "SERIES_CODE_INVALID",
    );
    expect(failure(() => manualSeries("EDO0123", EDO_VALUES)).code).toBe(
      "TEMPLATE_NOT_VALIDATED",
    );
  });

  it.each([
    ["a rate of zero", { firstPeriodRate: "0" }, "firstPeriodRate"],
    [
      "a rate over 25 percent",
      { firstPeriodRate: "0.2501" },
      "firstPeriodRate",
    ],
    ["a margin over 5 percent", { addend: "0.0501" }, "margin"],
    ["a fee over 10", { fee: "10.01" }, "fee"],
  ])("refuses %s with the bound", (_name, patch, field) => {
    const error = failure(() =>
      manualSeries("EDO1036", { ...EDO_VALUES, ...patch }),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe(field);
    expect(error.params.expected).toMatch(/^0/);
  });

  it.each([
    [
      "a rate as a percentage text",
      { firstPeriodRate: "5,35%" },
      "firstPeriodRate",
    ],
    ["a negative margin", { addend: "-0.01" }, "margin"],
    ["a missing margin", { addend: null }, "margin"],
    ["a missing fee", { fee: null }, "fee"],
    ["a fee in fractions of a grosz", { fee: "3.005" }, "fee"],
    [
      "a malformed letter number",
      { letter: { number: "99", date: "2026-09-21" } },
      "letterNumber",
    ],
    [
      "a malformed letter date",
      { letter: { number: "99/2026", date: "21.09.2026" } },
      "letterDate",
    ],
    [
      "a sale window that is not a date",
      { saleWindow: { from: "2026-10-01", to: "koniec" } },
      "saleWindow",
    ],
  ])("refuses %s", (_name, patch, field) => {
    const error = failure(() =>
      manualSeries("EDO1036", {
        ...EDO_VALUES,
        ...patch,
      } as ManualSeriesValues),
    );
    // An administrator's own input, never "the official source changed".
    expect(error.code).toBe("MANUAL_ENTRY_INVALID");
    expect(error.params.field).toBe(field);
  });

  it("refuses a margin for a fixed-rate product and a fee for OTS", () => {
    const base = {
      firstPeriodRate: "0.02",
      saleWindow: { from: "2026-10-01", to: "2026-10-31" },
      letter: { number: "94/2026", date: "2026-09-21" },
    };
    expect(
      failure(() =>
        manualSeries("OTS0127", { ...base, addend: "0.01", fee: null }),
      ).params.field,
    ).toBe("addend");
    expect(
      failure(() =>
        manualSeries("OTS0127", { ...base, addend: null, fee: "0.50" }),
      ).params.field,
    ).toBe("fee");
  });

  it("refuses a sale window that is not the code's sale month", () => {
    for (const saleWindow of [
      { from: "2026-09-01", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-11-30" },
      { from: "2026-10-31", to: "2026-10-01" },
    ]) {
      const error = failure(() =>
        manualSeries("EDO1036", { ...EDO_VALUES, saleWindow }),
      );
      expect(error.code).toBe("SOURCE_INCONSISTENT");
      expect(error.params.field).toBe("saleWindow");
    }
  });

  it("refuses a letter dated on or after the first day of sale", () => {
    const error = failure(() =>
      manualSeries("EDO1036", {
        ...EDO_VALUES,
        letter: { number: "99/2026", date: "2026-10-01" },
      }),
    );
    expect(error.params.field).toBe("letterDate");
  });
});
