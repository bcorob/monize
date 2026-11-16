import {
  isMultiAccountQif,
  parseQif,
  parseQifFull,
  resolveQifAccountType,
  validateQifContent,
} from "./qif-parser";

/**
 * Quicken for Mac's `.qmtf` transfer files are QIF, but spell the section
 * headers in capitals (`!TYPE:Bank`), list every account in one AutoSwitch
 * catalog, and may leave an account's type blank. A case-sensitive header
 * check read such a file as 0 accounts and 0 transactions.
 */

const LINE_ENDINGS: Array<[string, string]> = [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["bare CR", "\r"],
];

function qmtfExport(eol: string): string {
  return [
    "!OPTION:AUTOSWITCH",
    "!ACCOUNT",
    "NChecking",
    "TBank",
    "^",
    "NVisa",
    "TCCard",
    "L5000.00",
    "^",
    "NHouse",
    "TOth A",
    "DPrincipal residence",
    "^",
    "NOld Wallet",
    "T",
    "^",
    "!CLEAR:AUTOSWITCH",
    "!TYPE:Cat",
    "NGroceries",
    "E",
    "^",
    "NSalary",
    "I",
    "^",
    "!ACCOUNT",
    "NChecking",
    "T",
    "^",
    "!TYPE:Bank",
    "D3/ 1'26",
    "T-45.10",
    "PCorner Store",
    "LGroceries",
    "^",
    "D3/15'26",
    "T2,000.00",
    "PEmployer",
    "LSalary",
    "^",
    "!Account",
    "NVisa",
    "^",
    "!type:CCard",
    "D3/ 2'26",
    "T-12.00",
    "PCafe",
    "LGroceries",
    "^",
    "",
  ].join(eol);
}

describe("resolveQifAccountType", () => {
  it.each([
    ["Bank", "CHEQUING"],
    ["BANK", "CHEQUING"],
    ["ccard", "CREDIT_CARD"],
    [" Oth A ", "ASSET"],
    ["OTH L", "LINE_OF_CREDIT"],
    ["Invst", "INVESTMENT"],
    ["Cash", "CASH"],
  ])("maps %p to %s", (value, expected) => {
    expect(resolveQifAccountType(value)).toBe(expected);
  });

  it.each(["", "  ", "Gizmo", "Port"])(
    "leaves %p unknown rather than assume chequing",
    (value) => {
      expect(resolveQifAccountType(value)).toBeNull();
    },
  );
});

describe("section headers in any case", () => {
  it("validates a file whose only headers are lower or upper case", () => {
    expect(validateQifContent("!type:Bank\nD01/15/2026")).toEqual({
      valid: true,
    });
    expect(validateQifContent("!ACCOUNT\nNChecking")).toEqual({
      valid: true,
    });
  });

  it("detects a multi-account export from upper-case !ACCOUNT headers", () => {
    const content = "!ACCOUNT\nNA\n^\n!TYPE:Bank\n!ACCOUNT \nNB\n^\n";
    expect(isMultiAccountQif(content)).toBe(true);
  });

  it.each(["!TYPE:Bank", "!type:bank", "!TyPe:BANK"])(
    "parseQif reads transactions under %s",
    (header) => {
      const result = parseQif(`${header}\nD01/15/2026\nT-50.00\nPStore\n^\n`);
      expect(result.accountType).toBe("CHEQUING");
      expect(result.transactions).toHaveLength(1);
    },
  );

  it("parseQif skips an upper-case non-transaction section and resumes after it", () => {
    const qif = [
      "!TYPE:Cat",
      "NGroceries",
      "E",
      "^",
      "!TYPE:CCard",
      "D01/15/2026",
      "T-50.00",
      "PStore",
      "^",
    ].join("\n");
    const result = parseQif(qif);
    expect(result.accountType).toBe("CREDIT_CARD");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].payee).toBe("Store");
  });

  it("parseQif reads the account name from an upper-case !ACCOUNT section", () => {
    const qif =
      "!ACCOUNT\nNMy Card\nTCCard\n^\n!TYPE:CCard\nD01/15/2026\nT-5\n^\n";
    const result = parseQif(qif);
    expect(result.accountName).toBe("My Card");
    expect(result.transactions).toHaveLength(1);
  });
});

describe.each(LINE_ENDINGS)(
  "parseQifFull - Quicken for Mac export with %s line endings",
  (_name, eol) => {
    const content = qmtfExport(eol);

    it("is detected as a multi-account file", () => {
      expect(isMultiAccountQif(content)).toBe(true);
    });

    it("reads the categories and every transaction section", () => {
      const result = parseQifFull(content);
      expect(result.categoryDefs.map((c) => c.name)).toEqual([
        "Groceries",
        "Salary",
      ]);
      const checking = result.accountBlocks.find(
        (b) => b.accountName === "Checking",
      );
      const visa = result.accountBlocks.find((b) => b.accountName === "Visa");
      expect(checking?.accountType).toBe("CHEQUING");
      expect(checking?.transactions.map((t) => t.amount)).toEqual([
        -45.1, 2000,
      ]);
      expect(checking?.transactions[0].date).toBe("2026-03-01");
      expect(visa?.accountType).toBe("CREDIT_CARD");
      expect(visa?.transactions).toHaveLength(1);
    });

    it("keeps every catalog account, including those without transactions", () => {
      const result = parseQifFull(content);
      expect(result.accountBlocks.map((b) => b.accountName)).toEqual([
        "Checking",
        "Visa",
        "House",
        "Old Wallet",
      ]);
      const house = result.accountBlocks.find((b) => b.accountName === "House");
      expect(house).toMatchObject({
        accountType: "ASSET",
        description: "Principal residence",
        transactions: [],
      });
    });

    it("merges a catalog definition into the account's later section", () => {
      const result = parseQifFull(content);
      const visa = result.accountBlocks.find((b) => b.accountName === "Visa");
      // The later !Account repeats only the name; the limit is the catalog's.
      expect(visa?.creditLimit).toBe(5000);
    });

    it("leaves a blank account type unknown instead of chequing", () => {
      const result = parseQifFull(content);
      const wallet = result.accountBlocks.find(
        (b) => b.accountName === "Old Wallet",
      );
      expect(wallet?.accountType).toBeNull();
    });
  },
);

describe("parseQifFull - account types from the catalog", () => {
  it("takes the catalog's type when a section header names none QIF defines", () => {
    const qif = [
      "!Option:AutoSwitch",
      "!Account",
      "NHouse",
      "TOth A",
      "^",
      "!Clear:AutoSwitch",
      "!Account",
      "NHouse",
      "T",
      "^",
      "!Type:Property",
      "D01/15/2026",
      "T100.00",
      "^",
    ].join("\n");
    const result = parseQifFull(qif, "MM/DD/YYYY");
    expect(result.accountBlocks).toHaveLength(1);
    expect(result.accountBlocks[0].accountType).toBe("ASSET");
  });

  it("does not let a later definition's blank fields erase the catalog's", () => {
    const qif = [
      "!Account",
      "NCard",
      "TCCard",
      "DTravel card",
      "L2500",
      "^",
      "NCard",
      "T",
      "^",
    ].join("\n");
    const result = parseQifFull(qif, "MM/DD/YYYY");
    expect(result.accountBlocks).toEqual([
      expect.objectContaining({
        accountName: "Card",
        accountType: "CREDIT_CARD",
        description: "Travel card",
        creditLimit: 2500,
      }),
    ]);
  });

  it("creates no block for a catalog entry without a name", () => {
    const qif = "!Account\nTBank\n^\nNChecking\nTBank\n^\n";
    const result = parseQifFull(qif, "MM/DD/YYYY");
    expect(result.accountBlocks.map((b) => b.accountName)).toEqual([
      "Checking",
    ]);
  });
});
