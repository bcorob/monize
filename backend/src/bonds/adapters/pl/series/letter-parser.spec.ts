import { SeriesFetchError } from "../../../bond-adapter";
import { letterFixture } from "./fixture-helpers";
import { letterText, parseLetter } from "./letter-parser";

const failure = (fn: () => unknown): SeriesFetchError => {
  try {
    fn();
  } catch (error) {
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
};

describe("parseLetter (saved letters)", () => {
  it.each([
    [
      "EDO0934",
      "96/2024",
      "2024-08-22",
      "0.0655",
      "0.0200",
      "3.00",
      "2024-09-01",
      "2024-09-30",
    ],
    [
      "EDO1036",
      "99/2026",
      "2026-09-21",
      "0.0535",
      "0.0200",
      "3.00",
      "2026-10-01",
      "2026-10-31",
    ],
    [
      "ROR1027",
      "95/2026",
      "2026-09-21",
      "0.0400",
      "0.0000",
      "0.50",
      "2026-10-01",
      "2026-10-31",
    ],
    [
      "DOR1028",
      "96/2026",
      "2026-09-21",
      "0.0415",
      "0.0015",
      "0.70",
      "2026-10-01",
      "2026-10-31",
    ],
    [
      "COI1030",
      "98/2026",
      "2026-09-21",
      "0.0475",
      "0.0150",
      "2.00",
      "2026-10-01",
      "2026-10-31",
    ],
    [
      "ROS1032",
      "100/2026",
      "2026-09-21",
      "0.0500",
      "0.0200",
      "2.00",
      "2026-10-01",
      "2026-10-31",
    ],
    [
      "ROD1038",
      "101/2026",
      "2026-09-21",
      "0.0560",
      "0.0250",
      "3.00",
      "2026-10-01",
      "2026-10-31",
    ],
  ])("reads %s", (code, number, date, rate, margin, fee, from, to) => {
    expect(parseLetter(letterFixture(code))).toEqual({
      number,
      date,
      seriesCodes: [code],
      fixed: false,
      firstPeriodRate: rate,
      addend: margin,
      saleWindow: { from, to },
      fee,
      faceValue: "100.00",
    });
  });

  it.each([
    ["TOS1029", "97/2026", "0.0440", "1.00"],
    ["OTS0127", "94/2026", "0.0200", null],
  ])("reads the fixed rate of %s", (code, number, rate, fee) => {
    expect(parseLetter(letterFixture(code))).toMatchObject({
      number,
      seriesCodes: [code],
      fixed: true,
      firstPeriodRate: rate,
      addend: null,
      fee,
    });
  });

  it("is not fooled by the series a bond may be exchanged from", () => {
    expect(parseLetter(letterFixture("EDO1036")).seriesCodes).toEqual([
      "EDO1036",
    ]);
  });

  it("reads a phrase broken over lines and the typo in the EDO0934 letter", () => {
    const text = letterFixture("EDO0934");
    expect(text).toContain("stopa procentowa wynosi 6,55%");
    expect(
      parseLetter(text.replace("wynosi 6,55%", "wynos\n6,55%")).firstPeriodRate,
    ).toBe("0.0655");
  });

  it("reads a sale window written 'od 1 do dnia 31' (the January 2024 COI letter)", () => {
    const text = letterFixture("EDO1036").replace(
      "od 1 do 31 października",
      "od 1 do dnia 31 października",
    );
    expect(parseLetter(text).saleWindow).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it('reads a fee written without grosze (ROS1030, ROD1036: "nie wyższą niż 2 zł")', () => {
    const text = letterFixture("EDO1036").replace(
      "nie wyższą niż 3,00 zł",
      "nie wyższą niż 3 zł",
    );
    expect(parseLetter(text).fee).toBe("3.00");
  });

  it("finds a fee written as an amount instead of a cap", () => {
    const text = letterFixture("EDO1036").replace(
      "o kwotę narosłych odsetek, ale nie wyższą niż 3,00 zł",
      "w wysokości 4,00 zł",
    );
    expect(parseLetter(text).fee).toBe("4.00");
  });

  it("reports no fee when the letter has none, for the caller to decide", () => {
    const text = letterFixture("EDO1036").replace(
      /nie wyższą niż/g,
      "nie większą niż",
    );
    expect(parseLetter(text).fee).toBeNull();
  });

  it.each([
    [
      "the letter number",
      "LIST EMISYJNY nr 99/2026",
      "LIST nr 99/2026",
      "letterNumber",
    ],
    [
      "the letter date",
      "z dnia 21 września 2026 r.",
      "z dnia 21 wrzesnia 2026 r.",
      "letterDate",
    ],
    [
      "the series",
      "o nazwie skróconej\nEDO1036",
      "o nazwie\nEDO1036",
      "letterSeries",
    ],
    [
      "the face value",
      "Nominał jednej obligacji wynosi 100 zł",
      "Nominał obligacji",
      "faceValue",
    ],
    [
      "the sale window",
      "do sprzedaży w dniach od 1 do 31 października",
      "do sprzedaży od 1 października",
      "saleWindow",
    ],
    [
      "the first period rate",
      "stopa procentowa wynosi 5,35%",
      "stopa procentowa wynosi pięć",
      "firstPeriodRate",
    ],
    ["the margin", "stałą marżę w wysokości 2,00%", "stałą marżę", "margin"],
  ])(
    "names %s when it cannot be read",
    (_name, original, replacement, field) => {
      const base = letterFixture("EDO1036");
      expect(base).toContain(original);
      const error = failure(() =>
        parseLetter(base.replace(original, replacement)),
      );
      expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
      expect(error.params.field).toBe(field);
    },
  );
});

describe("letterText", () => {
  it("joins lines, drops soft hyphens and normalises white space", () => {
    expect(letterText("a\u00ad b\n  c\u00a0d\r\n")).toBe("a b c d");
  });
});
