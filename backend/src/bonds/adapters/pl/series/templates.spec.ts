import { parseBondTerms } from "../../../domain/bond-terms";
import { PRODUCT_TENOR_MONTHS, PolishProduct } from "./series-code";
import { fillTemplate, SERIES_TEMPLATES } from "./templates";

const products = Object.keys(PRODUCT_TENOR_MONTHS) as PolishProduct[];

/** Rates, fee, window, code and source of October 2026 must not survive in a template. */
const PER_SERIES = [
  "firstPeriodRate",
  "annualRate",
  "margin",
  "spread",
  "seriesCode",
  "saleWindow",
  "source",
  "amount",
];

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe("series templates", () => {
  it.each(products)("%s holds no per-series value", (product) => {
    const keys = keysOf(SERIES_TEMPLATES[product].structure);
    for (const key of PER_SERIES) expect(keys.has(key)).toBe(false);
  });

  it.each(products)(
    "%s is valid from the first sale month whose letter was checked",
    (product) => {
      expect(SERIES_TEMPLATES[product].validFrom).toBe("2024-01");
    },
  );

  it.each(products)(
    "%s fills into a document the strict parser accepts",
    (product) => {
      const t = SERIES_TEMPLATES[product];
      const terms = fillTemplate(t, {
        seriesCode: `${product}0127`,
        firstPeriodRate: "0.0100",
        addend: t.addend === null ? null : "0.0100",
        fee: t.hasFee ? "1.00" : null,
        saleWindow: { from: "2026-10-01", to: "2026-10-31" },
        source: {
          provider: "manual",
          url: "https://example.test/",
          document: "d",
        },
      });
      expect(parseBondTerms(terms).instrument.programCode).toBe(product);
    },
  );

  it("knows which products carry a margin, a spread or a fee", () => {
    expect(
      products.map((p) => [
        p,
        SERIES_TEMPLATES[p].addend,
        SERIES_TEMPLATES[p].hasFee,
      ]),
    ).toEqual([
      ["OTS", null, false],
      ["ROR", "spread", true],
      ["DOR", "spread", true],
      ["TOS", null, true],
      ["COI", "margin", true],
      ["ROS", "margin", true],
      ["EDO", "margin", true],
      ["ROD", "margin", true],
    ]);
  });
});
