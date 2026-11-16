import { manifestDocument, ManifestName } from "../adapters/pl/pl-test-input";
import { BondTermsError, parseBondTerms } from "./bond-terms";

type Doc = Record<string, any>;

const NAMES: ManifestName[] = [
  "tos1029",
  "ror1027",
  "coi1030",
  "edo1036",
  "dor1028",
  "ros1032",
  "rod1038",
  "ots0127",
];

function mutated(name: ManifestName, change: (doc: Doc) => void): unknown {
  const doc = manifestDocument(name);
  change(doc);
  return doc;
}

function refusal(input: unknown): BondTermsError {
  try {
    parseBondTerms(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BondTermsError);
    return error as BondTermsError;
  }
  throw new Error("expected parseBondTerms to throw");
}

const refusalOf = (
  change: (doc: Doc) => void,
  name: ManifestName = "ror1027",
) => refusal(mutated(name, change));

describe("parseBondTerms", () => {
  it.each(NAMES)("accepts the %s manifest unchanged", (name) => {
    expect(parseBondTerms(manifestDocument(name))).toEqual(
      manifestDocument(name),
    );
  });

  it("carries the letter values of the four manifests", () => {
    expect(parseBondTerms(manifestDocument("tos1029"))).toMatchObject({
      rateRule: { annualRate: "0.0440" },
      redemption: { penalties: [{ amount: "1.00" }] },
      schedule: { periodCount: 3, periodMonths: 12 },
      source: { document: "List emisyjny nr 97/2026" },
    });
    expect(parseBondTerms(manifestDocument("ror1027"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0400", spread: "0.0000" },
      redemption: {
        penalties: [{ amount: "0.50" }],
        blackouts: [{ businessDays: 5 }],
      },
      schedule: { periodCount: 12, periodMonths: 1 },
    });
    expect(parseBondTerms(manifestDocument("coi1030"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0475", margin: "0.0150" },
      redemption: {
        penalties: [{ amount: "2.00" }],
        proceedsFloor: { appliesTo: "FIRST_PERIOD" },
      },
    });
    expect(parseBondTerms(manifestDocument("edo1036"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0535", margin: "0.0200" },
      redemption: {
        penalties: [{ amount: "3.00" }],
        proceedsFloor: { appliesTo: "ALL_PERIODS" },
      },
      schedule: { periodCount: 10 },
    });
  });

  it("carries the letter values of the OTS manifest", () => {
    expect(parseBondTerms(manifestDocument("ots0127"))).toMatchObject({
      rateRule: { type: "FIXED", annualRate: "0.0200" },
      schedule: { periodCount: 1, periodMonths: 3 },
      capitalization: { type: "NONE" },
      redemption: {
        penalties: [{ type: "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT" }],
        proceedsFloor: null,
        blackouts: [],
      },
      source: { document: "List emisyjny nr 94/2026" },
    });
  });

  it("accepts the forfeit penalty without fields and refuses an extra one", () => {
    expect(
      parseBondTerms(
        mutated("ror1027", (d) => {
          d.redemption.penalties = [
            { type: "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT" },
          ];
        }),
      ).redemption,
    ).toMatchObject({
      penalties: [{ type: "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT" }],
    });
    expect(
      refusalOf((d) => {
        d.redemption.penalties = [
          { type: "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT", amount: "1.00" },
        ];
      }).field,
    ).toBe("terms.redemption.penalties[0].amount");
  });

  it("carries the letter values of the DOR, ROS and ROD manifests", () => {
    expect(parseBondTerms(manifestDocument("dor1028"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0415", spread: "0.0015" },
      redemption: {
        penalties: [{ amount: "0.70" }],
        blackouts: [{ businessDays: 5 }],
        proceedsFloor: { appliesTo: "FIRST_PERIOD" },
      },
      schedule: { periodCount: 24, periodMonths: 1 },
      source: { document: "List emisyjny nr 96/2026" },
    });
    expect(parseBondTerms(manifestDocument("ros1032"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0500", margin: "0.0200" },
      redemption: {
        penalties: [{ amount: "2.00" }],
        proceedsFloor: { appliesTo: "ALL_PERIODS" },
      },
      schedule: { periodCount: 6, periodMonths: 12 },
      source: { document: "List emisyjny nr 100/2026" },
    });
    expect(parseBondTerms(manifestDocument("rod1038"))).toMatchObject({
      rateRule: { firstPeriodRate: "0.0560", margin: "0.0250" },
      redemption: {
        penalties: [{ amount: "3.00" }],
        proceedsFloor: { appliesTo: "ALL_PERIODS" },
      },
      schedule: { periodCount: 12, periodMonths: 12 },
      source: { document: "List emisyjny nr 101/2026" },
    });
  });

  it("refuses a non-object document", () => {
    for (const input of [null, undefined, 1, "x", []])
      expect(refusal(input).field).toBe("terms");
  });

  it.each([
    ["top level", (d: Doc) => (d.extra = 1), "terms.extra"],
    ["instrument", (d: Doc) => (d.instrument.x = 1), "terms.instrument.x"],
    ["saleWindow", (d: Doc) => (d.saleWindow.x = 1), "terms.saleWindow.x"],
    ["schedule", (d: Doc) => (d.schedule.x = 1), "terms.schedule.x"],
    ["accrual", (d: Doc) => (d.accrual.x = 1), "terms.accrual.x"],
    [
      "principalRule",
      (d: Doc) => (d.principalRule.x = 1),
      "terms.principalRule.x",
    ],
    ["rateRule", (d: Doc) => (d.rateRule.x = 1), "terms.rateRule.x"],
    [
      "observation",
      (d: Doc) => (d.rateRule.observation.x = 1),
      "terms.rateRule.observation.x",
    ],
    [
      "capitalization",
      (d: Doc) => (d.capitalization.x = 1),
      "terms.capitalization.x",
    ],
    ["redemption", (d: Doc) => (d.redemption.x = 1), "terms.redemption.x"],
    [
      "blackout",
      (d: Doc) => (d.redemption.blackouts[0].x = 1),
      "terms.redemption.blackouts[0].x",
    ],
    [
      "penalty",
      (d: Doc) => (d.redemption.penalties[0].x = 1),
      "terms.redemption.penalties[0].x",
    ],
    [
      "floor",
      (d: Doc) => (d.redemption.proceedsFloor.x = 1),
      "terms.redemption.proceedsFloor.x",
    ],
    ["rounding", (d: Doc) => (d.rounding.x = 1), "terms.rounding.x"],
    ["source", (d: Doc) => (d.source.x = 1), "terms.source.x"],
  ])("refuses an unknown field in %s", (_name, change, field) => {
    expect(refusalOf(change).field).toBe(field);
  });

  it("refuses unknown fields in the other rule shapes", () => {
    expect(refusalOf((d) => (d.rateRule.x = 1), "tos1029").field).toBe(
      "terms.rateRule.x",
    );
    expect(refusalOf((d) => (d.rateRule.x = 1), "coi1030").field).toBe(
      "terms.rateRule.x",
    );
    expect(
      refusalOf((d) => (d.rateRule.observation.x = 1), "coi1030").field,
    ).toBe("terms.rateRule.observation.x");
    expect(refusalOf((d) => (d.capitalization.x = 1), "edo1036").field).toBe(
      "terms.capitalization.x",
    );
  });

  it("refuses a missing field", () => {
    expect(refusalOf((d) => delete d.instrument.faceValue).field).toBe(
      "terms.instrument.faceValue",
    );
  });

  it.each([
    [
      "faceValue",
      (d: Doc) => (d.instrument.faceValue = 100),
      "terms.instrument.faceValue",
    ],
    [
      "annualRate",
      (d: Doc) => (d.rateRule.annualRate = 0.044),
      "terms.rateRule.annualRate",
    ],
    [
      "fee",
      (d: Doc) => (d.redemption.penalties[0].amount = 1),
      "terms.redemption.penalties[0].amount",
    ],
  ])("refuses a JSON number for %s", (_name, change, field) => {
    const error = refusalOf(change, "tos1029");
    expect(error.field).toBe(field);
    expect(error.message).toContain(field);
  });

  it("refuses a number for a first-period rate and a floor", () => {
    expect(refusalOf((d) => (d.rateRule.firstPeriodRate = 0.04)).field).toBe(
      "terms.rateRule.firstPeriodRate",
    );
    expect(refusalOf((d) => (d.rateRule.benchmarkFloor = 0)).field).toBe(
      "terms.rateRule.benchmarkFloor",
    );
  });

  it("refuses malformed, negative and zero decimals", () => {
    expect(
      refusalOf((d) => (d.rateRule.annualRate = "4,4%"), "tos1029").message,
    ).toContain("not a decimal");
    expect(
      refusalOf((d) => (d.rateRule.annualRate = "-0.01"), "tos1029").message,
    ).toContain("negative");
    expect(
      refusalOf((d) => (d.instrument.faceValue = "0.00")).message,
    ).toContain("positive");
  });

  it("refuses an unknown primitive with its own code and the path", () => {
    const cases: [string, (d: Doc) => void][] = [
      ["terms.rateRule.type", (d) => (d.rateRule.type = "LADDER")],
      [
        "terms.rateRule.observation.type",
        (d) => (d.rateRule.observation.type = "X"),
      ],
      ["terms.capitalization.type", (d) => (d.capitalization.type = "SIMPLE")],
      ["terms.redemption.type", (d) => (d.redemption.type = "PUT")],
      [
        "terms.redemption.blackouts[0].type",
        (d) => (d.redemption.blackouts[0].type = "X"),
      ],
      [
        "terms.redemption.penalties[0].type",
        (d) => (d.redemption.penalties[0].type = "PERCENT"),
      ],
      [
        "terms.redemption.proceedsFloor.type",
        (d) => (d.redemption.proceedsFloor.type = "X"),
      ],
      ["terms.accrual.type", (d) => (d.accrual.type = "THIRTY_360")],
      ["terms.principalRule.type", (d) => (d.principalRule.type = "INDEXED")],
    ];
    for (const [field, change] of cases) {
      const error = refusalOf(change);
      expect(error).toMatchObject({ field, code: "UNSUPPORTED_PRIMITIVE" });
      expect(error.message).toContain(field);
    }
    expect(refusalOf((d) => (d.rateRule = "x")).field).toBe("terms.rateRule");
    expect(refusalOf((d) => (d.rateRule.type = 1)).field).toBe(
      "terms.rateRule.type",
    );
    expect(refusalOf((d) => (d.schemaVersion = 2)).code).toBe("INVALID");
  });

  it("refuses bad instrument fields", () => {
    expect(refusalOf((d) => (d.instrument.currency = "pln")).field).toBe(
      "terms.instrument.currency",
    );
    expect(
      refusalOf((d) => (d.instrument.issuerCountryCode = "POL")).field,
    ).toBe("terms.instrument.issuerCountryCode");
    expect(
      refusalOf((d) => (d.instrument.marketability = "TRADED")).field,
    ).toBe("terms.instrument.marketability");
    expect(refusalOf((d) => (d.instrument.seriesCode = " ")).field).toBe(
      "terms.instrument.seriesCode",
    );
  });

  it("accepts a null sale window and refuses a bad one", () => {
    expect(
      parseBondTerms(mutated("ror1027", (d) => (d.saleWindow = null)))
        .saleWindow,
    ).toBeNull();
    expect(refusalOf((d) => (d.saleWindow.from = "2026-02-30")).field).toBe(
      "terms.saleWindow.from",
    );
    expect(refusalOf((d) => (d.saleWindow.to = "2026-09-01")).field).toBe(
      "terms.saleWindow",
    );
  });

  it("refuses a period length that does not divide the year", () => {
    expect(refusalOf((d) => (d.schedule.periodMonths = 5)).field).toBe(
      "terms.schedule.periodMonths",
    );
    expect(refusalOf((d) => (d.schedule.periodMonths = 24)).field).toBe(
      "terms.schedule.periodMonths",
    );
    expect(refusalOf((d) => (d.schedule.periodMonths = 0)).field).toBe(
      "terms.schedule.periodMonths",
    );
    expect(
      parseBondTerms(mutated("ror1027", (d) => (d.schedule.periodMonths = 3))),
    ).toMatchObject({ schedule: { periodMonths: 3 } });
  });

  it("refuses bad schedule, rounding and source values", () => {
    expect(refusalOf((d) => (d.schedule.periodCount = 0)).field).toBe(
      "terms.schedule.periodCount",
    );
    expect(refusalOf((d) => (d.schedule.anchor = "SALE_DATE")).field).toBe(
      "terms.schedule.anchor",
    );
    expect(refusalOf((d) => (d.schedule.rollDay = "LAST")).field).toBe(
      "terms.schedule.rollDay",
    );
    expect(refusalOf((d) => (d.schedule.calendarId = "")).field).toBe(
      "terms.schedule.calendarId",
    );
    expect(refusalOf((d) => (d.rounding.moneyDecimals = 5)).field).toBe(
      "terms.rounding.moneyDecimals",
    );
    expect(refusalOf((d) => (d.rounding.moneyDecimals = 2.5)).field).toBe(
      "terms.rounding.moneyDecimals",
    );
    expect(refusalOf((d) => (d.rounding.moneyDecimals = "2")).field).toBe(
      "terms.rounding.moneyDecimals",
    );
    expect(refusalOf((d) => (d.rounding.moneyDecimals = -1)).code).toBe(
      "INVALID",
    );
    expect(refusalOf((d) => (d.rounding.mode = 1)).code).toBe("INVALID");
    expect(refusalOf((d) => (d.source.url = "")).field).toBe(
      "terms.source.url",
    );
  });

  it("accepts moneyDecimals 0..4 and the three rounding modes", () => {
    for (const moneyDecimals of [0, 1, 2, 3, 4]) {
      const terms = parseBondTerms(
        mutated("ror1027", (d) => (d.rounding.moneyDecimals = moneyDecimals)),
      );
      expect(terms.rounding.moneyDecimals).toBe(moneyDecimals);
    }
    for (const mode of ["HALF_UP", "HALF_EVEN", "DOWN"]) {
      const terms = parseBondTerms(
        mutated("ror1027", (d) => (d.rounding.mode = mode)),
      );
      expect(terms.rounding.mode).toBe(mode);
    }
  });

  it("an unknown rounding mode is an unsupported primitive", () => {
    const error = refusalOf((d) => (d.rounding.mode = "UP"));
    expect(error.field).toBe("terms.rounding.mode");
    expect(error.code).toBe("UNSUPPORTED_PRIMITIVE");
  });

  it("refuses bad redemption values", () => {
    expect(
      refusalOf((d) => (d.redemption.earliestDaysAfterPurchase = -1)).field,
    ).toBe("terms.redemption.earliestDaysAfterPurchase");
    expect(refusalOf((d) => (d.redemption.blackouts = {})).field).toBe(
      "terms.redemption.blackouts",
    );
    expect(
      refusalOf((d) => (d.redemption.blackouts[0].businessDays = 0)).field,
    ).toBe("terms.redemption.blackouts[0].businessDays");
    expect(
      refusalOf((d) => (d.redemption.proceedsFloor.appliesTo = "NEVER")).field,
    ).toBe("terms.redemption.proceedsFloor.appliesTo");
    expect(
      refusalOf((d) => (d.rateRule.observation.businessDays = 0)).field,
    ).toBe("terms.rateRule.observation.businessDays");
    expect(
      refusalOf((d) => (d.rateRule.observation.months = 0), "coi1030").field,
    ).toBe("terms.rateRule.observation.months");
    expect(
      refusalOf((d) => (d.capitalization.baseRounding = "UP"), "edo1036").field,
    ).toBe("terms.capitalization.baseRounding");
  });

  it("accepts a bond redeemable at maturity only, with null optional parts", () => {
    const terms = parseBondTerms(
      mutated("coi1030", (d) => {
        d.redemption = { type: "MATURITY_ONLY" };
        d.rateRule.firstPeriodRate = null;
        d.rateRule.benchmarkFloor = null;
      }),
    );
    expect(terms.redemption.type).toBe("MATURITY_ONLY");
  });

  it("accepts an on-demand redemption with no floor", () => {
    const terms = parseBondTerms(
      mutated("tos1029", (d) => (d.redemption.proceedsFloor = null)),
    );
    expect(terms.redemption).toMatchObject({ proceedsFloor: null });
  });

  it("refuses a record-day blackout on a compounding bond", () => {
    const error = refusalOf(
      (d) =>
        (d.redemption.blackouts = [
          {
            type: "RECORD_DAY_BEFORE_COUPON",
            businessDays: 5,
            calendarId: "PL",
          },
        ]),
      "edo1036",
    );
    expect(error.field).toBe("terms.redemption.blackouts");
  });

  it("accepts an unknown calendar id and benchmark id: the engine reports them", () => {
    const terms = parseBondTerms(
      mutated("ror1027", (d) => {
        d.schedule.calendarId = "XX";
        d.rateRule.benchmarkId = "XX_RATE";
      }),
    );
    expect(terms.schedule.calendarId).toBe("XX");
  });
});

describe("parseBondTerms: a discount instrument", () => {
  /** A country-neutral discount bill; the terms of the engine's spec 3. */
  function discountDoc(change: (doc: Doc) => void = () => undefined): Doc {
    const doc = manifestDocument("tos1029");
    doc.instrument.faceValue = "24000.00";
    doc.instrument.issuePrice = "23530.00";
    doc.schedule = {
      anchor: "ISSUE_DATE",
      issueDate: "2026-01-01",
      maturityDate: "2026-01-27",
      periodCount: 1,
      calendarId: "PL",
    };
    doc.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
    doc.capitalization = { type: "NONE" };
    doc.redemption = { type: "MATURITY_ONLY" };
    change(doc);
    return doc;
  }

  it("accepts the discount rule, the issue price and the issue-date schedule unchanged", () => {
    expect(parseBondTerms(discountDoc())).toEqual(discountDoc());
  });

  it.each([
    [
      "an issue price missing",
      (d: Doc) => delete d.instrument.issuePrice,
      "terms.instrument.issuePrice",
    ],
    [
      "an issue price at the face value",
      (d: Doc) => (d.instrument.issuePrice = "24000.00"),
      "terms.instrument.issuePrice",
    ],
    [
      "an issue price above the face value",
      (d: Doc) => (d.instrument.issuePrice = "24000.01"),
      "terms.instrument.issuePrice",
    ],
    [
      "a zero issue price",
      (d: Doc) => (d.instrument.issuePrice = "0"),
      "terms.instrument.issuePrice",
    ],
    [
      "a negative issue price",
      (d: Doc) => (d.instrument.issuePrice = "-1"),
      "terms.instrument.issuePrice",
    ],
    [
      "an issue price as a JSON number",
      (d: Doc) => (d.instrument.issuePrice = 23530),
      "terms.instrument.issuePrice",
    ],
    [
      "early redemption",
      (d: Doc) => {
        d.redemption = manifestDocument("tos1029").redemption;
      },
      "terms.redemption",
    ],
    [
      "capitalisation",
      (d: Doc) =>
        (d.capitalization = {
          type: "COMPOUND_AT_PERIOD_END",
          baseRounding: "NONE",
        }),
      "terms.capitalization",
    ],
    [
      "a schedule counted from the purchase date",
      (d: Doc) => {
        d.schedule = manifestDocument("tos1029").schedule;
      },
      "terms.schedule.anchor",
    ],
    [
      "a maturity on the issue date",
      (d: Doc) => (d.schedule.maturityDate = "2026-01-01"),
      "terms.schedule.maturityDate",
    ],
    [
      "a maturity before the issue date",
      (d: Doc) => (d.schedule.maturityDate = "2025-12-31"),
      "terms.schedule.maturityDate",
    ],
    [
      "an impossible issue date",
      (d: Doc) => (d.schedule.issueDate = "2026-02-30"),
      "terms.schedule.issueDate",
    ],
    [
      "more than one period",
      (d: Doc) => (d.schedule.periodCount = 2),
      "terms.schedule.periodCount",
    ],
    [
      "a period length in months",
      (d: Doc) => (d.schedule.periodMonths = 12),
      "terms.schedule.periodMonths",
    ],
    [
      "a rate beside the rule",
      (d: Doc) => (d.rateRule.annualRate = "0.01"),
      "terms.rateRule.annualRate",
    ],
  ])("refuses %s", (_name, change, field) => {
    expect(refusal(discountDoc(change)).field).toBe(field);
  });

  it("refuses an issue price on an instrument that is not a discount", () => {
    expect(refusalOf((d) => (d.instrument.issuePrice = "99.00")).field).toBe(
      "terms.instrument.issuePrice",
    );
  });

  it("refuses an issue-date schedule on an instrument that is not a discount", () => {
    expect(
      refusalOf((d) => {
        d.schedule = discountDoc().schedule;
      }).field,
    ).toBe("terms.schedule.anchor");
  });

  it("refuses an unknown field of the issue-date schedule and an unknown anchor", () => {
    expect(
      refusal(discountDoc((d) => (d.schedule.rollDay = "ANCHOR_DAY_CLAMPED")))
        .field,
    ).toBe("terms.schedule.rollDay");
    expect(
      refusal(discountDoc((d) => (d.schedule.anchor = "SETTLEMENT_DATE")))
        .field,
    ).toBe("terms.schedule.anchor");
  });
});
