import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  mnyAccount,
  mnyCategory,
  mnyCurrency,
  mnyDefaults,
  mnyPayee,
  referenceData,
} from "../__fixtures__/mny-row-builders";
import { MNY_ACCOUNT_TYPE } from "../model/mny-model";
import {
  DEFAULT_MNY_IMPORT_OPTIONS,
  resolveImportOptions,
} from "../model/mny-import-options";
import {
  currencyCodesByHandle,
  isDegeneratePayeeName,
  mapAccounts,
  mapCategories,
  mapPayees,
  resolveBaseCurrency,
} from "./map-reference";

const USD = mnyCurrency({ handle: 10, isoCode: "USD" });
const GBP = mnyCurrency({ handle: 20, isoCode: "GBP", name: "British pound" });

describe("currencyCodesByHandle", () => {
  it("indexes usable ISO codes and upper-cases them", () => {
    const map = currencyCodesByHandle(
      referenceData({
        currencies: [USD, mnyCurrency({ handle: 30, isoCode: "cad" })],
      }),
    );

    expect(map.get(10)).toBe("USD");
    expect(map.get(30)).toBe("CAD");
  });

  it("drops rows with no handle or a non-ISO code", () => {
    const map = currencyCodesByHandle(
      referenceData({
        currencies: [
          mnyCurrency({ handle: null }),
          mnyCurrency({ handle: 40, isoCode: "" }),
          mnyCurrency({ handle: 50, isoCode: "EUROS" }),
        ],
      }),
    );

    expect(map.size).toBe(0);
  });
});

describe("resolveBaseCurrency", () => {
  it("takes the file's own default currency", () => {
    expect(
      resolveBaseCurrency(
        referenceData({
          currencies: [USD, GBP],
          defaults: mnyDefaults({ defaultCurrency: 20 }),
        }),
        "CAD",
      ),
    ).toBe("GBP");
  });

  it("falls back to the user's preference when the file has no default", () => {
    expect(
      resolveBaseCurrency(referenceData({ currencies: [USD] }), "cad"),
    ).toBe("CAD");
  });

  it("falls back when the default points at a currency the file lacks", () => {
    expect(
      resolveBaseCurrency(
        referenceData({
          currencies: [USD],
          defaults: mnyDefaults({ defaultCurrency: 999 }),
        }),
        "CAD",
      ),
    ).toBe("CAD");
  });
});

describe("mapAccounts", () => {
  const options = DEFAULT_MNY_IMPORT_OPTIONS;

  function withAccounts(accounts: Parameters<typeof mnyAccount>[0][]) {
    return referenceData({
      currencies: [USD, GBP],
      defaults: mnyDefaults({ defaultCurrency: 10 }),
      accounts: accounts.map((overrides) => mnyAccount(overrides)),
    });
  }

  describe("account types", () => {
    // Every `at` value in the Money format reference, and what Monize calls it.
    const cases: Array<[number, AccountType]> = [
      [MNY_ACCOUNT_TYPE.BANK, AccountType.CHEQUING],
      [MNY_ACCOUNT_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
      [MNY_ACCOUNT_TYPE.CASH, AccountType.CASH],
      [MNY_ACCOUNT_TYPE.ASSET, AccountType.ASSET],
      [MNY_ACCOUNT_TYPE.LOAN, AccountType.LOAN],
      [MNY_ACCOUNT_TYPE.MORTGAGE, AccountType.MORTGAGE],
    ];

    it.each(cases)("maps at=%i to %s", (at, expected) => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, type: at, name: "Account" }]),
        options,
        "USD",
      );

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].accountType).toBe(expected);
      expect(result.accounts[0].accountSubType).toBeNull();
    });

    it("maps at=5 to a linked investment pair", () => {
      const result = mapAccounts(
        withAccounts([
          { handle: 1, type: MNY_ACCOUNT_TYPE.INVESTMENT, name: "TFSA" },
        ]),
        options,
        "USD",
      );

      expect(result.accounts.map((a) => a.accountSubType)).toEqual([
        AccountSubType.INVESTMENT_CASH,
        AccountSubType.INVESTMENT_BROKERAGE,
      ]);
      expect(result.accounts.map((a) => a.name)).toEqual([
        "TFSA - Cash",
        "TFSA - Brokerage",
      ]);
      const [cash, brokerage] = result.accounts;
      expect(cash.linkedKey).toBe(brokerage.key);
      expect(brokerage.linkedKey).toBe(cash.key);
    });

    it("skips an unknown at code with a warning rather than guessing", () => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, type: 99, name: "Mystery" }]),
        options,
        "USD",
      );

      expect(result.accounts).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        { code: "unknownAccountType", subject: "Mystery", detail: "at=99" },
      ]);
    });

    it("skips a row with no handle", () => {
      const result = mapAccounts(
        withAccounts([{ handle: null, name: "Handleless" }]),
        options,
        "USD",
      );

      expect(result.accounts).toEqual([]);
      expect(result.skipped).toBe(1);
    });
  });

  describe("investment pairing through hacctRel", () => {
    // The layout confirmed in money2002.mny: hacct 2 is at=5 pointing at
    // hacct 3, the at=0 cash companion, which points back.
    const paired = [
      {
        handle: 2,
        type: MNY_ACCOUNT_TYPE.INVESTMENT,
        name: "None Investment",
        relatedAccount: 3,
      },
      {
        handle: 3,
        type: MNY_ACCOUNT_TYPE.BANK,
        name: "None Investment (Cash)",
        relatedAccount: 2,
        openingBalance: 250,
      },
    ];

    it("does not also create the companion as a chequing account", () => {
      const result = mapAccounts(withAccounts(paired), options, "USD");

      expect(result.accounts).toHaveLength(2);
      expect(
        result.accounts.every((a) => a.accountType === AccountType.INVESTMENT),
      ).toBe(true);
    });

    it("routes each Money account's transactions to the right side", () => {
      const result = mapAccounts(withAccounts(paired), options, "USD");
      const [cash, brokerage] = result.accounts;

      expect(result.keyByHandle.get(3)).toBe(cash.key);
      expect(result.keyByHandle.get(2)).toBe(brokerage.key);
    });

    it("keeps the cash opening balance on the cash side", () => {
      const result = mapAccounts(withAccounts(paired), options, "USD");

      expect(result.accounts[0].openingBalance).toBe(250);
      expect(result.accounts[1].openingBalance).toBe(0);
    });

    it("synthesizes a cash side when the investment account has no companion", () => {
      const result = mapAccounts(
        withAccounts([
          {
            handle: 7,
            type: MNY_ACCOUNT_TYPE.INVESTMENT,
            name: "Watchlist",
            openingBalance: 40,
          },
        ]),
        options,
        "USD",
      );

      expect(result.accounts[0].handle).toBeNull();
      expect(result.accounts[0].openingBalance).toBe(40);
      expect(result.keyByHandle.get(7)).toBe(result.accounts[1].key);
    });

    it("closes both sides when either Money row is closed", () => {
      const result = mapAccounts(
        withAccounts([
          { ...paired[0], closed: false },
          { ...paired[1], closed: true, closedOn: "2024-03-01" },
        ]),
        options,
        "USD",
      );

      expect(result.accounts.map((a) => a.closed)).toEqual([true, true]);
      expect(result.accounts[0].closedDate).toBe("2024-03-01");
    });

    it("treats hacctRel pointing at another investment account as no companion", () => {
      const result = mapAccounts(
        withAccounts([
          {
            handle: 1,
            type: MNY_ACCOUNT_TYPE.INVESTMENT,
            name: "A",
            relatedAccount: 2,
          },
          {
            handle: 2,
            type: MNY_ACCOUNT_TYPE.INVESTMENT,
            name: "B",
            relatedAccount: 1,
          },
        ]),
        options,
        "USD",
      );

      // Two investment accounts, so two pairs -- four Monize accounts.
      expect(result.accounts).toHaveLength(4);
    });
  });

  describe("currencies", () => {
    it("uses the account's own currency", () => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, name: "UK", currency: 20 }]),
        options,
        "USD",
      );

      expect(result.accounts[0].currencyCode).toBe("GBP");
      expect(result.currencyCodes).toEqual(
        expect.arrayContaining(["USD", "GBP"]),
      );
    });

    it("falls back to the base currency and warns on an unknown handle", () => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, name: "Odd", currency: 555 }]),
        options,
        "USD",
      );

      expect(result.accounts[0].currencyCode).toBe("USD");
      expect(result.warnings).toEqual([
        { code: "unknownCurrency", subject: "Odd", detail: "hcrnc=555" },
      ]);
    });

    it("applies a per-account override from the wizard", () => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, name: "Reclassified", currency: 20 }]),
        resolveImportOptions({
          accounts: [{ handle: 1, include: true, currencyOverride: "cad" }],
        }),
        "USD",
      );

      expect(result.accounts[0].currencyCode).toBe("CAD");
    });
  });

  describe("selection", () => {
    it("leaves out an unticked account", () => {
      const result = mapAccounts(
        withAccounts([
          { handle: 1, name: "Keep" },
          { handle: 2, name: "Drop" },
        ]),
        resolveImportOptions({
          accounts: [{ handle: 2, include: false, currencyOverride: null }],
        }),
        "USD",
      );

      expect(result.accounts.map((a) => a.name)).toEqual(["Keep"]);
      expect(result.keyByHandle.has(2)).toBe(false);
      expect(result.skipped).toBe(1);
    });

    it("leaves out closed accounts when the option is off", () => {
      const result = mapAccounts(
        withAccounts([
          { handle: 1, name: "Open" },
          { handle: 2, name: "Shut", closed: true },
        ]),
        resolveImportOptions({ importClosedAccounts: false }),
        "USD",
      );

      expect(result.accounts.map((a) => a.name)).toEqual(["Open"]);
    });
  });

  describe("flags and details", () => {
    it("carries closed, favourite, comment and closed date through", () => {
      const result = mapAccounts(
        withAccounts([
          {
            handle: 1,
            name: "Old Savings",
            closed: true,
            closedOn: "2020-12-31",
            favourite: true,
            comment: "Closed when we moved",
          },
        ]),
        options,
        "USD",
      );

      expect(result.accounts[0]).toMatchObject({
        closed: true,
        closedDate: "2020-12-31",
        favourite: true,
        description: "Closed when we moved",
      });
    });

    it("excludes a watch account from net worth, on both sides of its pair", () => {
      // Money's "Investments to Watch" (`fWatch`) tracks quotes, never money,
      // so importing it into net worth would count phantom value.
      const result = mapAccounts(
        withAccounts([
          {
            handle: 1,
            type: MNY_ACCOUNT_TYPE.INVESTMENT,
            name: "Investments to Watch",
            watch: true,
          },
          { handle: 2, name: "Chequing" },
        ]),
        options,
        "USD",
      );

      expect(
        result.accounts.map((a) => [a.name, a.excludeFromNetWorth]),
      ).toEqual([
        ["Investments to Watch - Cash", true],
        ["Investments to Watch - Brokerage", true],
        ["Chequing", false],
      ]);
    });

    it("excludes the pair when only the cash companion carries the watch flag", () => {
      const result = mapAccounts(
        withAccounts([
          {
            handle: 2,
            type: MNY_ACCOUNT_TYPE.INVESTMENT,
            name: "Watchlist",
            relatedAccount: 3,
          },
          {
            handle: 3,
            type: MNY_ACCOUNT_TYPE.BANK,
            name: "Watchlist (Cash)",
            relatedAccount: 2,
            watch: true,
          },
        ]),
        options,
        "USD",
      );

      expect(result.accounts.map((a) => a.excludeFromNetWorth)).toEqual([
        true,
        true,
      ]);
    });

    it("does not treat a name prefix as a closure signal", () => {
      // PR #192 read a 'z ' prefix as "closed"; that was one user's filing
      // convention, not a Money semantic.
      const result = mapAccounts(
        withAccounts([{ handle: 1, name: "z Old Account", closed: false }]),
        options,
        "USD",
      );

      expect(result.accounts[0].closed).toBe(false);
      expect(result.accounts[0].name).toBe("z Old Account");
    });

    it("keeps a credit limit only where the account type has one", () => {
      const result = mapAccounts(
        withAccounts([
          {
            handle: 1,
            type: MNY_ACCOUNT_TYPE.CREDIT_CARD,
            name: "Visa",
            creditLimit: 5000,
          },
          {
            handle: 2,
            type: MNY_ACCOUNT_TYPE.BANK,
            name: "Chequing",
            creditLimit: 5000,
          },
        ]),
        options,
        "USD",
      );

      expect(result.accounts[0].creditLimit).toBe(5000);
      expect(result.accounts[1].creditLimit).toBeNull();
    });

    it("de-duplicates names case-insensitively and warns", () => {
      const result = mapAccounts(
        withAccounts([
          { handle: 1, name: "Savings" },
          { handle: 2, name: "savings" },
          { handle: 3, name: "SAVINGS" },
        ]),
        options,
        "USD",
      );

      expect(result.accounts.map((a) => a.name)).toEqual([
        "Savings",
        "savings (2)",
        "SAVINGS (3)",
      ]);
      expect(result.warnings.map((w) => w.code)).toEqual([
        "duplicateAccountName",
        "duplicateAccountName",
      ]);
    });

    it("gives a nameless account a placeholder rather than an empty name", () => {
      const result = mapAccounts(
        withAccounts([{ handle: 1, name: "   " }]),
        options,
        "USD",
      );

      expect(result.accounts[0].name).toBe("Account");
    });
  });
});

describe("mapCategories", () => {
  // Money's real shape, from the fixtures: two level-0 roots, user categories
  // hanging off them.
  const EXPENSE_ROOT = mnyCategory({
    handle: 131,
    name: "EXPENSE",
    level: 0,
    parent: null,
    categoryType: -1,
  });
  const INCOME_ROOT = mnyCategory({
    handle: 130,
    name: "INCOME",
    level: 0,
    parent: null,
    categoryType: -1,
  });

  function tree(categories: ReturnType<typeof mnyCategory>[]) {
    return referenceData({
      categories: [INCOME_ROOT, EXPENSE_ROOT, ...categories].sort(
        (a, b) => a.level - b.level,
      ),
    });
  }

  it("drops Money's own INCOME and EXPENSE roots", () => {
    const result = mapCategories(tree([]), null);

    expect(result.categories).toEqual([]);
  });

  it("maps a level-1 category to a Monize top-level category", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 200, name: "Utilities", level: 1, parent: 131 }),
      ]),
      null,
    );

    expect(result.categories).toEqual([
      {
        handle: 200,
        parentName: null,
        name: "Utilities",
        fullName: "Utilities",
        isIncome: false,
      },
    ]);
  });

  it("maps a level-2 category to a child of its level-1 ancestor", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 200, name: "Utilities", level: 1, parent: 131 }),
        mnyCategory({ handle: 201, name: "Gas", level: 2, parent: 200 }),
      ]),
      null,
    );

    expect(result.byHandle.get(201)).toEqual({
      handle: 201,
      parentName: "Utilities",
      name: "Gas",
      fullName: "Utilities:Gas",
      isIncome: false,
    });
  });

  it("flattens a tree deeper than two levels into a colon-joined child", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 200, name: "Utilities", level: 1, parent: 131 }),
        mnyCategory({ handle: 201, name: "Gas", level: 2, parent: 200 }),
        mnyCategory({ handle: 202, name: "Winter", level: 3, parent: 201 }),
        mnyCategory({ handle: 203, name: "Peak", level: 4, parent: 202 }),
      ]),
      null,
    );

    expect(result.byHandle.get(202)).toMatchObject({
      parentName: "Utilities",
      name: "Gas:Winter",
    });
    expect(result.byHandle.get(203)).toMatchObject({
      parentName: "Utilities",
      name: "Gas:Winter:Peak",
    });
    expect(
      result.warnings.filter((w) => w.code === "categoryFlattened"),
    ).toHaveLength(2);
  });

  it("keeps two flattened subcategories distinct instead of merging them", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 200, name: "Auto", level: 1, parent: 131 }),
        mnyCategory({ handle: 201, name: "Car A", level: 2, parent: 200 }),
        mnyCategory({ handle: 202, name: "Car B", level: 2, parent: 200 }),
        mnyCategory({ handle: 203, name: "Fuel", level: 3, parent: 201 }),
        mnyCategory({ handle: 204, name: "Fuel", level: 3, parent: 202 }),
      ]),
      null,
    );

    expect(result.byHandle.get(203)!.fullName).toBe("Auto:Car A:Fuel");
    expect(result.byHandle.get(204)!.fullName).toBe("Auto:Car B:Fuel");
  });

  describe("income classification", () => {
    it("reads lType directly", () => {
      const result = mapCategories(
        tree([
          mnyCategory({
            handle: 300,
            name: "Salary",
            level: 1,
            parent: 130,
            categoryType: 2,
          }),
          mnyCategory({
            handle: 301,
            name: "Bonus",
            level: 1,
            parent: 130,
            categoryType: 3,
          }),
          mnyCategory({
            handle: 302,
            name: "Rent",
            level: 1,
            parent: 131,
            categoryType: 1,
          }),
        ]),
        null,
      );

      expect(result.byHandle.get(300)!.isIncome).toBe(true);
      expect(result.byHandle.get(301)!.isIncome).toBe(true);
      expect(result.byHandle.get(302)!.isIncome).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it("walks to the root ancestor when lType is outside the known set", () => {
      const result = mapCategories(
        tree([
          mnyCategory({
            handle: 300,
            name: "Odd Income",
            level: 1,
            parent: 130,
            categoryType: 77,
          }),
          mnyCategory({
            handle: 301,
            name: "Odd Expense",
            level: 1,
            parent: 131,
            categoryType: 77,
          }),
        ]),
        null,
      );

      expect(result.byHandle.get(300)!.isIncome).toBe(true);
      expect(result.byHandle.get(301)!.isIncome).toBe(false);
      expect(
        result.warnings.filter((w) => w.code === "categoryTypeInferred"),
      ).toHaveLength(2);
    });
  });

  describe("referenced-only filtering", () => {
    const withThree = () =>
      tree([
        mnyCategory({ handle: 200, name: "Utilities", level: 1, parent: 131 }),
        mnyCategory({ handle: 201, name: "Gas", level: 2, parent: 200 }),
        mnyCategory({ handle: 202, name: "Never Used", level: 1, parent: 131 }),
      ]);

    it("imports the whole tree when no filter is given", () => {
      expect(mapCategories(withThree(), null).categories).toHaveLength(3);
    });

    it("leaves out categories no transaction references", () => {
      const result = mapCategories(withThree(), new Set([201]));

      expect(result.categories.map((c) => c.fullName)).toEqual([
        "Utilities",
        "Utilities:Gas",
      ]);
      expect(result.skipped).toBe(2);
    });

    it("brings in an unreferenced parent so the child is not orphaned", () => {
      const result = mapCategories(withThree(), new Set([201]));
      const parent = result.categories.find((c) => c.fullName === "Utilities");

      expect(parent).toMatchObject({ handle: 200, isIncome: false });
    });

    it("gives an implied income parent the right income flag", () => {
      const result = mapCategories(
        tree([
          mnyCategory({
            handle: 300,
            name: "Investments",
            level: 1,
            parent: 130,
            categoryType: 2,
          }),
          mnyCategory({
            handle: 301,
            name: "Dividends",
            level: 2,
            parent: 300,
            categoryType: 2,
          }),
        ]),
        new Set([301]),
      );

      expect(
        result.categories.find((c) => c.fullName === "Investments")!.isIncome,
      ).toBe(true);
    });
  });

  it("orders parents before children so the writer can create in order", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 201, name: "Gas", level: 2, parent: 200 }),
        mnyCategory({ handle: 200, name: "Utilities", level: 1, parent: 131 }),
      ]),
      null,
    );

    const parentIndex = result.categories.findIndex(
      (c) => c.parentName === null,
    );
    const childIndex = result.categories.findIndex(
      (c) => c.parentName !== null,
    );
    expect(parentIndex).toBeLessThan(childIndex);
  });

  it("skips a blank name and a handleless row", () => {
    const result = mapCategories(
      tree([
        mnyCategory({ handle: 200, name: "   ", level: 1, parent: 131 }),
        mnyCategory({ handle: null, name: "Nameless", level: 1, parent: 131 }),
      ]),
      null,
    );

    expect(result.categories).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("does not spin on a cyclic parent chain", () => {
    const result = mapCategories(
      referenceData({
        categories: [
          mnyCategory({ handle: 1, name: "A", level: 1, parent: 2 }),
          mnyCategory({ handle: 2, name: "B", level: 1, parent: 1 }),
        ],
      }),
      null,
    );

    expect(result.categories.length).toBeGreaterThan(0);
  });
});

describe("isDegeneratePayeeName", () => {
  it.each(["#", "*", "", "   ", "--", "..", "_", " # "])(
    "treats %p as junk",
    (name) => {
      expect(isDegeneratePayeeName(name)).toBe(true);
    },
  );

  it.each(["Costco", "7-Eleven", "A.B. Store", "#1 Diner"])(
    "treats %p as a real payee",
    (name) => {
      expect(isDegeneratePayeeName(name)).toBe(false);
    },
  );
});

describe("mapPayees", () => {
  it("skips Money's degenerate rows whatever the filter says", () => {
    const result = mapPayees(
      [
        mnyPayee({ handle: 1, name: "#" }),
        mnyPayee({ handle: 2, name: "*" }),
        mnyPayee({ handle: 3, name: "  " }),
        mnyPayee({ handle: 4, name: "Costco" }),
      ],
      null,
    );

    expect(result.payees.map((p) => p.name)).toEqual(["Costco"]);
    expect(result.skipped).toBe(3);
    expect(
      result.warnings.filter((w) => w.code === "degeneratePayeeSkipped"),
    ).toHaveLength(3);
  });

  it("reports a blank name legibly in the warning", () => {
    const result = mapPayees([mnyPayee({ handle: 1, name: "   " })], null);

    expect(result.warnings[0].subject).toBe("(blank)");
  });

  it("imports only referenced payees when asked", () => {
    const result = mapPayees(
      [
        mnyPayee({ handle: 1, name: "Used" }),
        mnyPayee({ handle: 2, name: "Unused" }),
      ],
      new Set([1]),
    );

    expect(result.payees.map((p) => p.name)).toEqual(["Used"]);
    expect(result.skipped).toBe(1);
  });

  it("collapses names that differ only in case, mapping both handles", () => {
    const result = mapPayees(
      [
        mnyPayee({ handle: 1, name: "Costco" }),
        mnyPayee({ handle: 2, name: "COSTCO" }),
      ],
      null,
    );

    expect(result.payees).toHaveLength(1);
    expect(result.nameByHandle.get(1)).toBe("Costco");
    expect(result.nameByHandle.get(2)).toBe("COSTCO");
  });

  it("trims surrounding whitespace", () => {
    const result = mapPayees(
      [mnyPayee({ handle: 1, name: "  Costco " })],
      null,
    );

    expect(result.payees[0].name).toBe("Costco");
  });

  it("skips a handleless row", () => {
    const result = mapPayees([mnyPayee({ handle: null, name: "Ghost" })], null);

    expect(result.payees).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});
