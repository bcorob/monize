import { fakeMnyDatabase } from "../__fixtures__/fake-mny-database";
import { readReferenceData } from "./read-reference";

describe("readReferenceData", () => {
  it("returns null defaults when the file has no DHD row", () => {
    // Never fall back to a hardcoded currency: the wizard uses the user's
    // preference when the file cannot say.
    expect(readReferenceData(fakeMnyDatabase({})).defaults).toBeNull();
    expect(
      readReferenceData(
        fakeMnyDatabase({ DHD: { columns: ["hcrncDef"], rows: [] } }),
      ).defaults,
    ).toBeNull();
  });

  it("reads payees, which are empty in every sample file", () => {
    const db = fakeMnyDatabase({
      PAY: {
        columns: ["hpay", "szFull", "fHidden"],
        rows: [
          { hpay: 4, szFull: "  Acme Ltd  ", fHidden: false },
          { hpay: 5, szFull: "#", fHidden: true },
        ],
      },
    });

    expect(readReferenceData(db).payees).toEqual([
      { handle: 4, name: "Acme Ltd", hidden: false },
      // Degenerate names survive the reader; filtering them is the mapper's
      // job, so the preview can report how many were skipped.
      { handle: 5, name: "#", hidden: true },
    ]);
  });

  it("reads classifications from CT, dropping the category tree's own row", () => {
    const db = fakeMnyDatabase({
      CT: {
        columns: ["hct", "szFull"],
        rows: [
          { hct: 0, szFull: "Category" },
          { hct: 1, szFull: "Properties" },
          // No usable handle: nothing in CAT can point at it.
          { hct: null, szFull: "damaged" },
        ],
      },
    });

    expect(readReferenceData(db).classifications).toEqual([
      { handle: 1, name: "Properties" },
    ]);
  });

  it("reads which tree a CAT row belongs to, defaulting to the category tree", () => {
    const withType = fakeMnyDatabase({
      CAT: {
        columns: ["hcat", "szFull", "hcatParent", "nLevel", "hct", "lType"],
        rows: [
          {
            hcat: 552,
            szFull: "20 Spring Apartment",
            hcatParent: null,
            nLevel: 0,
            hct: 1,
            lType: -1,
          },
        ],
      },
    });
    expect(readReferenceData(withType).categories[0]).toMatchObject({
      handle: 552,
      classification: 1,
    });

    // A vintage without `hct` has no classifications: every row is a category.
    const without = fakeMnyDatabase({
      CAT: {
        columns: ["hcat", "szFull", "hcatParent", "nLevel", "lType"],
        rows: [
          {
            hcat: 200,
            szFull: "Groceries",
            hcatParent: 131,
            nLevel: 1,
            lType: 0,
          },
        ],
      },
    });
    expect(readReferenceData(without).categories[0].classification).toBe(0);
  });

  it("reads exchange rates", () => {
    const db = fakeMnyDatabase({
      CRNC_EXCHG: {
        columns: ["hcrncFrom", "hcrncTo", "rate", "dt", "fHist"],
        rows: [
          {
            hcrncFrom: 18,
            hcrncTo: 45,
            rate: 1.6234,
            dt: new Date(Date.UTC(2011, 4, 2)),
            fHist: true,
          },
        ],
      },
    });

    expect(readReferenceData(db).exchangeRates).toEqual([
      {
        fromCurrency: 18,
        toCurrency: 45,
        rate: 1.6234,
        date: "2011-05-02",
        historical: true,
      },
    ]);
  });

  it("keeps a credit limit and closing date on an account", () => {
    const db = fakeMnyDatabase({
      ACCT: {
        columns: [
          "hacct",
          "at",
          "szFull",
          "amtLimit",
          "dtClose",
          "fClosed",
          "mComment",
        ],
        rows: [
          {
            hacct: 8,
            at: 1,
            szFull: "Visa",
            amtLimit: "5000.0000",
            dtClose: new Date(Date.UTC(2009, 10, 30)),
            fClosed: true,
            mComment: "",
          },
        ],
      },
    });

    expect(readReferenceData(db).accounts[0]).toMatchObject({
      handle: 8,
      type: 1,
      name: "Visa",
      creditLimit: 5000,
      closedOn: "2009-11-30",
      closed: true,
      comment: null,
    });
  });

  it("defaults an unknown account type to -1 rather than to a bank account", () => {
    const db = fakeMnyDatabase({
      ACCT: { columns: ["hacct"], rows: [{ hacct: 1 }] },
    });

    // 0 is Money's bank-account code, so it must never be the fallback.
    expect(readReferenceData(db).accounts[0].type).toBe(-1);
  });

  it("degrades to empty collections when no reference table exists", () => {
    const result = readReferenceData(fakeMnyDatabase({}));

    expect(result.currencies).toEqual([]);
    expect(result.exchangeRates).toEqual([]);
    expect(result.accounts).toEqual([]);
    expect(result.payees).toEqual([]);
    expect(result.categories).toEqual([]);
  });
});
