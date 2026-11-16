import { parseCsvRows } from "../import/csv-parser";
import {
  WarrantyCsvContext,
  WarrantyCsvRow,
  mapWarrantyCsv,
  parseSerialNumbers,
  parseWarrantyKind,
} from "./warranty-csv";

const HEADER =
  "ProductName,PurchaseDate,WarrantyDurationYears,WarrantyDurationMonths,WarrantyDurationDays,ExpirationDate,IsLifetime,PurchasePrice,SerialNumber,ProductURL,Vendor,Tags,Notes,Currency,ModelNumber,WarrantyType";

/**
 * A Warracker-style export: a duration row, an expiration-date row, a lifetime
 * row, a row whose serials are a JSON array (one holding a comma) with an
 * unknown currency, and a row with no expiry source.
 */
const WARRACKER_SAMPLE = [
  HEADER,
  'Laptop,2026-01-31,1,6,0,,false,1499.99,"SN-1, SN-2",https://example.com/laptop,Best Buy,"work,tech",Keep the box,CAD,X1,Manufacturer',
  "Fridge,2025-05-01,0,0,0,2030-05-01,false,,,,Home Depot,,,,,Extended Warranty",
  "Backpack,2024-03-15,,,,,TRUE,120,,,,,,,,Lifetime",
  'Camera,2026-02-10,2,,,,no,899.5,"[""AB,12"",""CD-34""]",,,,,XYZ,,store',
  "Toaster,2026-03-01,0,0,0,,false,25,,,,,,USD,,",
].join("\r\n");

const CTX: WarrantyCsvContext = {
  defaultCurrency: "CAD",
  knownCurrencies: new Set(["CAD", "USD", "EUR"]),
};

const map = (csv: string, ctx: WarrantyCsvContext = CTX) =>
  mapWarrantyCsv(parseCsvRows(csv, ","), ctx);

/** One data row under a header naming only the columns it gives. */
function row(fields: Record<string, string>): WarrantyCsvRow {
  const base: Record<string, string> = {
    ProductName: "Laptop",
    PurchaseDate: "2026-01-01",
    ExpirationDate: "2027-01-01",
    ...fields,
  };
  const keys = Object.keys(base);
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = `${keys.join(",")}\n${keys.map((k) => quote(base[k])).join(",")}\n`;
  const result = map(csv);
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

describe("mapWarrantyCsv: the Warracker sample", () => {
  const result = map(WARRACKER_SAMPLE);

  it("gives one verdict per data row, numbered from the header's line 1", () => {
    expect(result.missingColumns).toEqual([]);
    expect(
      result.rows.map((r) => [r.line, r.name, r.outcome, r.expiresOn]),
    ).toEqual([
      [2, "Laptop", "valid", "2027-07-31"],
      [3, "Fridge", "valid", "2030-05-01"],
      [4, "Backpack", "valid", null],
      [5, "Camera", "valid", "2028-02-10"],
      [6, "Toaster", "invalid", null],
    ]);
  });

  it("reports Tags as skipped and nothing else", () => {
    expect(result.skippedColumns).toEqual(["Tags"]);
  });

  it("turns a duration row into a term the create path resolves (termToExpiresOn)", () => {
    const [laptop] = result.rows;
    expect(laptop.errors).toEqual([]);
    expect(laptop.warnings).toEqual([]);
    expect(laptop.warranty).toEqual({
      name: "Laptop",
      purchaseDate: "2026-01-31",
      term: { years: 1, months: 6, days: 0 },
      purchasePrice: 1499.99,
      currencyCode: "CAD",
      serialNumbers: ["SN-1", "SN-2"],
      productUrl: "https://example.com/laptop",
      vendorName: "Best Buy",
      notes: "Keep the box",
      modelNumber: "X1",
      warrantyKind: "manufacturer",
    });
  });

  it("keeps an expiration-date row's date, maps 'Extended Warranty', and needs no currency without a price", () => {
    const fridge = result.rows[1].warranty;
    expect(fridge?.expiresOn).toBe("2030-05-01");
    expect(fridge?.term).toBeUndefined();
    expect(fridge?.warrantyKind).toBe("extended");
    expect(fridge?.purchasePrice).toBeUndefined();
    expect(fridge?.currencyCode).toBeUndefined();
  });

  it("reads TRUE as lifetime, takes the default currency for a blank one, and imports an unknown kind as other with a warning", () => {
    const backpack = result.rows[2];
    expect(backpack.warranty?.isLifetime).toBe(true);
    expect(backpack.warranty?.expiresOn).toBeUndefined();
    expect(backpack.warranty?.purchasePrice).toBe(120);
    expect(backpack.warranty?.currencyCode).toBe("CAD");
    expect(backpack.warranty?.warrantyKind).toBe("other");
    expect(backpack.warnings).toEqual([
      'WarrantyType "Lifetime" is not manufacturer, extended, store or other; imported as other',
    ]);
  });

  it("reads a JSON-array serial holding a comma and falls back from an unknown currency", () => {
    const camera = result.rows[3];
    expect(camera.warranty?.serialNumbers).toEqual(["AB,12", "CD-34"]);
    expect(camera.warranty?.currencyCode).toBe("CAD");
    expect(camera.warnings).toEqual([
      'Currency "XYZ" is not known; CAD was used',
    ]);
  });

  it("refuses a row with no expiry source and says which columns to fill", () => {
    const toaster = result.rows[4];
    expect(toaster.warranty).toBeNull();
    expect(toaster.errors).toEqual([
      "Fill ExpirationDate, a WarrantyDuration column or IsLifetime",
    ]);
  });
});

describe("mapWarrantyCsv: headers", () => {
  it("matches a header ignoring case and surrounding spaces", () => {
    const result = map(
      " productname ,PURCHASEDATE, isLifetime \nLaptop,2026-01-01,yes\n",
    );
    expect(result.skippedColumns).toEqual([]);
    expect(result.rows[0].outcome).toBe("valid");
    expect(result.rows[0].warranty?.isLifetime).toBe(true);
  });

  it("reports an unknown header once, and a repeated known one as skipped", () => {
    const result = map(
      "ProductName,PurchaseDate,Colour,IsLifetime,Colour,productname\nLaptop,2026-01-01,red,1,blue,Other\n",
    );
    expect(result.skippedColumns).toEqual(["Colour", "productname"]);
    expect(result.rows[0].warranty?.name).toBe("Laptop");
  });

  it("names the required columns a header row lacks and maps no row", () => {
    const result = map("Name,Date\nLaptop,2026-01-01\n");
    expect(result.missingColumns).toEqual(["ProductName", "PurchaseDate"]);
    expect(result.rows).toEqual([]);
  });
});

describe("mapWarrantyCsv: row rules", () => {
  it("accepts true, 1 and yes in any case as lifetime, and refuses another word", () => {
    for (const value of ["true", "1", "yes", "YES", "True"]) {
      expect(
        row({ ExpirationDate: "", IsLifetime: value }).warranty?.isLifetime,
      ).toBe(true);
    }
    expect(row({ IsLifetime: "maybe" }).errors).toEqual([
      "IsLifetime must be true, false, yes, no, 1 or 0",
    ]);
  });

  describe("ExpirationDate beside a duration (Warracker exports both)", () => {
    it("takes the date and notes the agreeing duration as ignored", () => {
      // 2026-01-01 plus one year is the row's ExpirationDate, 2027-01-01.
      const result = row({ WarrantyDurationYears: "1" });
      expect(result.outcome).toBe("valid");
      expect(result.expiresOn).toBe("2027-01-01");
      expect(result.warranty?.expiresOn).toBe("2027-01-01");
      expect(result.warranty?.term).toBeUndefined();
      expect(result.warnings).toEqual([
        "ExpirationDate was used; the WarrantyDuration columns beside it were ignored",
      ]);
    });

    it("still takes the date when the duration disagrees, and says so", () => {
      const result = row({ WarrantyDurationMonths: "6" });
      expect(result.outcome).toBe("valid");
      expect(result.warranty?.expiresOn).toBe("2027-01-01");
      expect(result.warranty?.term).toBeUndefined();
      expect(result.warnings).toEqual([
        "ExpirationDate 2027-01-01 was used; the WarrantyDuration columns give 2026-07-01, which disagrees",
      ]);
    });

    it("adds no warning for a zero duration beside the date", () => {
      expect(
        row({
          WarrantyDurationYears: "0",
          WarrantyDurationMonths: "0",
          WarrantyDurationDays: "0",
        }).warnings,
      ).toEqual([]);
    });
  });

  it("refuses lifetime beside a date or a duration as a contradiction", () => {
    const message =
      "IsLifetime is true, but the row also gives ExpirationDate or a WarrantyDuration; fill only one";
    expect(row({ IsLifetime: "true" }).errors).toEqual([message]);
    expect(
      row({ ExpirationDate: "", IsLifetime: "yes", WarrantyDurationYears: "2" })
        .errors,
    ).toEqual([message]);
  });

  it("refuses a duration that is not a whole number in the DTO's bounds", () => {
    expect(
      row({ ExpirationDate: "", WarrantyDurationYears: "1.5" }).errors,
    ).toContain("WarrantyDurationYears must be a whole number from 0 to 100");
    expect(
      row({ ExpirationDate: "", WarrantyDurationDays: "36501" }).errors,
    ).toContain("WarrantyDurationDays must be a whole number from 0 to 36500");
  });

  it("refuses dates that are not real YYYY-MM-DD dates, and a blank purchase date", () => {
    expect(row({ PurchaseDate: "01/02/2026" }).errors).toContain(
      "PurchaseDate must be a date in YYYY-MM-DD form",
    );
    expect(row({ ExpirationDate: "2027-02-30" }).errors).toEqual([
      "ExpirationDate must be a date in YYYY-MM-DD form",
    ]);
    expect(row({ PurchaseDate: "" }).errors).toEqual([
      "PurchaseDate is required",
    ]);
  });

  it("refuses an expiry before the purchase", () => {
    expect(row({ ExpirationDate: "2025-12-31" }).errors).toEqual([
      "A warranty cannot expire before its purchase date",
    ]);
  });

  it("requires a product name within 200 characters", () => {
    expect(row({ ProductName: "  " }).errors).toEqual([
      "ProductName is required",
    ]);
    expect(row({ ProductName: "x".repeat(201) }).errors).toEqual([
      "ProductName must be at most 200 characters",
    ]);
  });

  it("holds the free-text columns to the DTO's lengths", () => {
    expect(row({ Notes: "n".repeat(2001) }).errors).toEqual([
      "Notes must be at most 2000 characters",
    ]);
    expect(row({ ModelNumber: "m".repeat(101) }).errors).toEqual([
      "ModelNumber must be at most 100 characters",
    ]);
    expect(row({ Vendor: "v".repeat(201) }).errors).toEqual([
      "Vendor must be at most 200 characters",
    ]);
  });

  it("refuses a product URL that is not an http or https address", () => {
    for (const url of ["example.com/x", "ftp://example.com/x"]) {
      expect(row({ ProductURL: url }).errors).toEqual([
        "ProductURL must be an http or https address",
      ]);
    }
  });

  it("strips HTML angle brackets as the API's DTO does", () => {
    expect(row({ ProductName: "<b>Laptop</b>" }).warranty?.name).toBe(
      "bLaptop/b",
    );
  });

  describe("price and currency", () => {
    it("refuses a negative price", () => {
      expect(row({ PurchasePrice: "-5", Currency: "CAD" }).errors).toEqual([
        "PurchasePrice must not be negative",
      ]);
    });

    it("refuses a price that is not a plain number of at most 4 decimals", () => {
      for (const price of ["12.34567", "1,299.99", "$5", "1e3"]) {
        expect(row({ PurchasePrice: price }).errors).toEqual([
          "PurchasePrice must be a number from 0 to 999999999999 with at most 4 decimal places",
        ]);
      }
    });

    it("refuses a currency without a price rather than guessing one", () => {
      expect(row({ Currency: "USD" }).errors).toEqual([
        "Currency is set but PurchasePrice is blank",
      ]);
    });

    it("keeps a known currency in any case and defaults a blank one silently", () => {
      expect(
        row({ PurchasePrice: "10", Currency: "usd" }).warranty?.currencyCode,
      ).toBe("USD");
      const blank = row({ PurchasePrice: "0" });
      expect(blank.warranty?.purchasePrice).toBe(0);
      expect(blank.warranty?.currencyCode).toBe("CAD");
      expect(blank.warnings).toEqual([]);
    });

    it("takes the default it is given, not a constant", () => {
      const result = map(
        "ProductName,PurchaseDate,IsLifetime,PurchasePrice\nLaptop,2026-01-01,1,10\n",
        { defaultCurrency: "EUR", knownCurrencies: new Set(["EUR"]) },
      );
      expect(result.rows[0].warranty?.currencyCode).toBe("EUR");
    });
  });

  describe("serial numbers", () => {
    it("refuses more than 10 and any longer than 100 characters", () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `S${i}`).join(",");
      expect(row({ SerialNumber: eleven }).errors).toEqual([
        "SerialNumber holds 11 values; at most 10 are allowed",
      ]);
      expect(row({ SerialNumber: "s".repeat(101) }).errors).toEqual([
        "Each serial number must be at most 100 characters",
      ]);
    });

    it("refuses a value that starts with [ but is not a JSON array of text", () => {
      expect(row({ SerialNumber: "[not json" }).errors).toEqual([
        "SerialNumber starts with [ but is not a JSON array of text",
      ]);
      expect(row({ SerialNumber: '[{"a":1}]' }).errors).toEqual([
        "SerialNumber starts with [ but is not a JSON array of text",
      ]);
    });
  });
});

describe("parseSerialNumbers", () => {
  it("splits on commas and drops blanks", () => {
    expect(parseSerialNumbers(" A , B,,C ")).toEqual({
      values: ["A", "B", "C"],
    });
    expect(parseSerialNumbers("")).toEqual({ values: [] });
  });

  it("reads a JSON array, numbers included, as text", () => {
    expect(parseSerialNumbers('["A,1", 42, " "]')).toEqual({
      values: ["A,1", "42"],
    });
  });
});

describe("parseWarrantyKind", () => {
  it("maps the four kinds in any case, with or without 'warranty'", () => {
    expect(parseWarrantyKind("Store Warranty")).toEqual({
      kind: "store",
      known: true,
    });
    expect(parseWarrantyKind("OTHER")).toEqual({ kind: "other", known: true });
    expect(parseWarrantyKind("")).toEqual({ kind: null, known: true });
    expect(parseWarrantyKind("Accidental damage")).toEqual({
      kind: "other",
      known: false,
    });
  });
});
