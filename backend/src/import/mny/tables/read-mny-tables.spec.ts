import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "../__fixtures__/mny-fixtures";
import { MnyDatabase, openMnyFile } from "../msisam/open-mny";
import { missingFields, missingTables, readMnyTables } from "./read-mny-tables";

/**
 * Reader specs run against every committed fixture: the point of this layer is
 * that a Money 2001, 2002 or Money Plus file all read without special-casing.
 */
function open(fixture: MnyFixtureName): MnyDatabase {
  return openMnyFile(readMnyFixture(fixture), MNY_FIXTURES[fixture].password);
}

const ALL_FIXTURES = Object.keys(MNY_FIXTURES) as MnyFixtureName[];

describe("readMnyTables", () => {
  it.each(ALL_FIXTURES)("reads %s without throwing", (fixture) => {
    const tables = readMnyTables(open(fixture));

    expect(tables.reference.accounts.length).toBeGreaterThan(0);
    expect(tables.reference.currencies.length).toBeGreaterThan(0);
    expect(tables.transactions.transactions.length).toBeGreaterThan(0);
  });

  /**
   * The per-version column-presence matrix, pinned. Every entry is a field the
   * mappers will see as a converter default on that vintage, so growing this
   * list must be a deliberate act rather than a silent data loss.
   */
  const EXPECTED_MISSING_FIELDS: Record<MnyFixtureName, string[]> = {
    // Money 2001 predates both the hidden-currency flag and bill series.
    money2001: ["CRNC.hidden", "TRN.billSeries"],
    money2001Pwd: ["CRNC.hidden", "TRN.billSeries"],
    // Money 2002 gained TRN.hbillHead; CRNC.fHidden is Money Plus only.
    money2002: ["CRNC.hidden"],
    money2008: [],
    money2008Pwd: [],
  };

  it.each(ALL_FIXTURES)("resolves the expected columns for %s", (fixture) => {
    expect(missingFields(readMnyTables(open(fixture)))).toEqual(
      EXPECTED_MISSING_FIELDS[fixture],
    );
  });

  it("reports BILL as the only missing table on Money 2001", () => {
    expect(missingTables(readMnyTables(open("money2001")))).toEqual(["BILL"]);
  });

  it.each(["money2002", "money2008"] as const)(
    "finds every table on %s",
    (fixture) => {
      expect(missingTables(readMnyTables(open(fixture)))).toEqual([]);
    },
  );
});

describe("reference data", () => {
  it.each([
    ["money2002", "GBP"],
    ["money2008", "USD"],
  ] as const)("reads the base currency of %s as %s", (fixture, isoCode) => {
    // DHD.hcrncDef is the file's own default currency -- never a hardcoded
    // locale guess, which is what the PR #192 proof of concept did.
    const { reference } = readMnyTables(open(fixture));
    const base = reference.currencies.find(
      (currency) => currency.handle === reference.defaults?.defaultCurrency,
    );

    expect(base?.isoCode).toBe(isoCode);
  });

  it("reads accounts with their type, currency and flags", () => {
    const { reference } = readMnyTables(open("money2002"));

    expect(reference.accounts).toEqual([
      expect.objectContaining({
        handle: 1,
        type: 5,
        name: "Investments to Watch",
        relatedAccount: null,
        closed: false,
        favourite: false,
        // Money's built-in watch account is the only fWatch row in the file.
        watch: true,
        openingBalance: 0,
      }),
      expect.objectContaining({
        handle: 2,
        type: 5,
        relatedAccount: 3,
        watch: false,
      }),
      expect.objectContaining({
        handle: 3,
        type: 0,
        name: "None Investment (Cash)",
        relatedAccount: 2,
        watch: false,
      }),
    ]);
  });

  it("nulls the year-10000 sentinel Money writes for an unset open date", () => {
    const { reference } = readMnyTables(open("money2002"));

    expect(
      reference.accounts.every((account) => account.openedOn === null),
    ).toBe(true);
  });

  it("orders categories so a parent always precedes its children", () => {
    const { reference } = readMnyTables(open("money2008"));
    const seen = new Set<number>();

    for (const category of reference.categories) {
      if (category.parent !== null) {
        expect(seen.has(category.parent)).toBe(true);
      }
      if (category.handle !== null) {
        seen.add(category.handle);
      }
    }
    expect(reference.categories.length).toBeGreaterThan(10);
  });

  it("reads the two category roots with no parent", () => {
    const { reference } = readMnyTables(open("money2008"));
    const roots = reference.categories.filter(
      (category) => category.level === 0,
    );

    expect(roots.map((root) => root.name).sort()).toEqual([
      "EXPENSE",
      "INCOME",
    ]);
    expect(roots.every((root) => root.parent === null)).toBe(true);
  });
});

describe("transaction data", () => {
  it("reads the payee handle from lHpay on Money Plus files", () => {
    const money2008 = readMnyTables(open("money2008"));

    expect(
      money2008.transactions.availability.find((entry) => entry.table === "TRN")
        ?.resolvedColumns.payee,
    ).toBe("lHpay");
  });

  it("reads the payee handle from hpay on pre-Money Plus files", () => {
    const money2002 = readMnyTables(open("money2002"));

    expect(
      money2002.transactions.availability.find((entry) => entry.table === "TRN")
        ?.resolvedColumns.payee,
    ).toBe("hpay");
  });

  it("normalises Money Plus's -1 payee handle to null", () => {
    const { transactions } = readMnyTables(open("money2008"));

    expect(transactions.transactions.every((row) => row.payee === null)).toBe(
      true,
    );
  });

  it("reads dates, amounts and flags", () => {
    const { transactions } = readMnyTables(open("money2002"));

    expect(transactions.transactions[0]).toEqual({
      handle: 1,
      account: 2,
      linkedAccount: null,
      payee: null,
      category: 131,
      security: 57,
      date: "2011-06-24",
      amount: 0.08,
      clearedStatus: 0,
      flags: 2,
      action: 15,
      frequency: -1,
      reference: null,
      memo: "Positions adjusted to match statement.",
      billSeries: null,
    });
  });
});

describe("investment data", () => {
  it("reads securities with their type and currency", () => {
    const { investments } = readMnyTables(open("money2008"));

    expect(investments.securities[0]).toMatchObject({
      handle: 1,
      symbol: "$US:INDU",
      name: "Dow Jones Industrial Average",
      securityType: 7,
      currency: 45,
    });
  });

  it("resolves the security of a stock split through the price rows", () => {
    // SEC_SPLIT carries no security handle of its own.
    const { investments } = readMnyTables(open("money2002"));

    for (const [split, security] of investments.splitSecurities) {
      expect(
        investments.securitySplits.some((row) => row.handle === split),
      ).toBe(true);
      expect(
        investments.securities.some((row) => row.handle === security),
      ).toBe(true);
    }
  });
});

describe("bill data", () => {
  it("reports Money 2001 as having no scheduled bills", () => {
    const { bills } = readMnyTables(open("money2001"));

    expect(bills.supported).toBe(false);
    expect(bills.bills).toEqual([]);
  });

  it.each(["money2002", "money2008"] as const)(
    "supports bills on %s",
    (fixture) => {
      expect(readMnyTables(open(fixture)).bills.supported).toBe(true);
    },
  );
});
