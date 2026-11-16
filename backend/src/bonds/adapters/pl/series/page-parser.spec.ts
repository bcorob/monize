import { SeriesFetchError } from "../../../bond-adapter";
import { pageFixture } from "./fixture-helpers";
import { pageText, parseSeriesPage } from "./page-parser";

const failure = (fn: () => unknown): SeriesFetchError => {
  try {
    fn();
  } catch (error) {
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
};

describe("parseSeriesPage (saved pages)", () => {
  it("reads an inflation-indexed series: EDO0934", () => {
    expect(parseSeriesPage(pageFixture("EDO0934"))).toEqual({
      seriesCode: "EDO0934",
      firstPeriodRate: "0.0655",
      addend: { kind: "margin", value: "0.0200" },
      saleWindow: { from: "2024-09-01", to: "2024-09-30" },
      price: "100.00",
      letterHref: "/media_files/d76b6f32-7da7-4852-b949-846cca1530a1.pdf",
    });
  });

  it("reads EDO1036", () => {
    const page = parseSeriesPage(pageFixture("EDO1036"));
    expect(page.firstPeriodRate).toBe("0.0535");
    expect(page.addend).toEqual({ kind: "margin", value: "0.0200" });
    expect(page.saleWindow).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("reads a reference-rate series with a zero spread: ROR1027", () => {
    const page = parseSeriesPage(pageFixture("ROR1027"));
    expect(page.firstPeriodRate).toBe("0.0400");
    expect(page.addend).toEqual({ kind: "spread", value: "0.0000" });
  });

  it("reads a reference-rate series with a spread: DOR1028", () => {
    const page = parseSeriesPage(pageFixture("DOR1028"));
    expect(page.firstPeriodRate).toBe("0.0415");
    expect(page.addend).toEqual({ kind: "spread", value: "0.0015" });
  });

  it.each([
    ["TOS1029", "0.0440"],
    ["OTS0127", "0.0200"],
  ])("reads a fixed-rate series with no margin: %s", (code, rate) => {
    const page = parseSeriesPage(pageFixture(code));
    expect(page.seriesCode).toBe(code);
    expect(page.firstPeriodRate).toBe(rate);
    expect(page.addend).toBeNull();
  });

  it.each([
    ["COI1030", "0.0475", "0.0150"],
    ["ROS1032", "0.0500", "0.0200"],
    ["ROD1038", "0.0560", "0.0250"],
  ])("reads %s", (code, rate, margin) => {
    const page = parseSeriesPage(pageFixture(code));
    expect(page.firstPeriodRate).toBe(rate);
    expect(page.addend).toEqual({ kind: "margin", value: margin });
    expect(page.price).toBe("100.00");
  });

  it("says a page with no Seria field is a series that is not published", () => {
    const error = failure(() =>
      parseSeriesPage(
        "<html><body><h1>Nie znaleziono strony</h1></body></html>",
      ),
    );
    expect(error.code).toBe("SERIES_NOT_PUBLISHED");
  });

  it("reports the series a page names, so the caller can refuse another one", () => {
    const other = pageFixture("EDO1036").replace("EDO1036", "EDO1136");
    expect(parseSeriesPage(other).seriesCode).toBe("EDO1136");
  });

  it.each([
    ["Sprzedaż:", "01.10.2026 - 31.10.2026", "saleWindow", "wkrótce"],
    ["Cena sprzedaży jednej obligacji:", "100,00", "price", "brak"],
  ])(
    "names the field %s when its value cannot be read",
    (_label, original, field, bad) => {
      const html = pageFixture("EDO1036").replace(original, bad);
      const error = failure(() => parseSeriesPage(html));
      expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
      expect(error.params.field).toBe(field);
    },
  );

  it("names the rate when the Oprocentowanie field carries no percentage", () => {
    const html = pageFixture("EDO1036").replace(/5,35%/, "do ustalenia");
    const error = failure(() => parseSeriesPage(html));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("firstPeriodRate");
  });

  it("names the letter link when the page has none", () => {
    const html = pageFixture("EDO1036").replace(
      "Zobacz list emisyjny",
      "Zobacz",
    );
    const error = failure(() => parseSeriesPage(html));
    expect(error.params.field).toBe("letterLink");
  });

  it("refuses a date that does not exist", () => {
    const html = pageFixture("EDO1036").replace("31.10.2026", "31.11.2026");
    expect(failure(() => parseSeriesPage(html)).params.field).toBe(
      "saleWindow",
    );
  });
});

describe("pageText", () => {
  it("drops scripts, styles and comments and decodes entities", () => {
    expect(
      pageText(
        "<p>a&nbsp;b</p><script>var x = 'Seria: HACK';</script><style>.a{}</style><!-- Seria: X --><b>&#160;c &amp; d&#x21;</b>",
      ),
    ).toBe("a b c & d!");
  });

  it("drops a script or style whose end tag carries junk before its >", () => {
    expect(
      pageText(
        "a<script>var x = 'Seria: HACK';</script\t\n bar>b<STYLE>.a{}</style foo>c<script>y</SCRIPT >d",
      ),
    ).toBe("a b c d");
  });

  it("leaves an entity it does not know and a bad code point alone", () => {
    expect(pageText("&unknown; &#99999999;")).toBe("&unknown;");
  });
});
