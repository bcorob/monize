import {
  buildTransactionSearchClause,
  escapeLikePattern,
} from "./transaction-search.util";

describe("escapeLikePattern", () => {
  it("escapes backslash, percent, and underscore", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns plain text unchanged", () => {
    expect(escapeLikePattern("groceries")).toBe("groceries");
  });
});

describe("buildTransactionSearchClause", () => {
  it("matches all the user-visible transaction fields", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    // Existing fields
    expect(clause).toContain("transaction.description ILIKE :search");
    expect(clause).toContain("transaction.payeeName ILIKE :search");
    expect(clause).toContain("transaction.referenceNumber ILIKE :search");
    expect(clause).toContain("splits.memo ILIKE :search");

    // New fields
    expect(clause).toContain("CAST(transaction.amount AS TEXT) ILIKE :search");
    expect(clause).toContain("CAST(splits.amount AS TEXT) ILIKE :search");
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM payees [^)]*name ILIKE :search\)/,
    );
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM categories [^)]*transaction\.category_id[^)]*name ILIKE :search\)/,
    );
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM categories [^)]*splits\.category_id[^)]*name ILIKE :search\)/,
    );
    expect(clause).toContain("transaction_tags");
    expect(clause).toContain("transaction_split_tags");
  });

  it("matches a transfer leg by its counterpart account's name (issue #1214)", () => {
    // A blank-payee transfer displays "Transfer to/from <counterpart>"
    // resolved at read time, so searching the counterpart's name has to find
    // the leg the way searching the stamped payee text used to.
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "EXISTS (SELECT 1 FROM transactions search_lt JOIN accounts search_la ON search_la.id = search_lt.account_id WHERE search_lt.id = transaction.linked_transaction_id AND transaction.is_transfer = true AND search_la.name ILIKE :search)",
    );
  });

  it("emits guarded, cast exact-amount terms for parent and split", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "(CAST(:searchAmount AS numeric) IS NOT NULL AND ABS(transaction.amount) = ABS(CAST(:searchAmount AS numeric)))",
    );
    expect(clause).toContain(
      "(CAST(:searchAmount AS numeric) IS NOT NULL AND ABS(splits.amount) = ABS(CAST(:searchAmount AS numeric)))",
    );
  });

  it("emits a guarded, cast exact-date term", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "(CAST(:searchDate AS date) IS NOT NULL AND transaction.transactionDate = CAST(:searchDate AS date))",
    );
  });

  it("respects custom alias and parameter names", () => {
    const clause = buildTransactionSearchClause({
      transaction: "bf",
      splits: "bfSplits",
      paramName: "bfSearch",
    });

    expect(clause).toContain("bf.description ILIKE :bfSearch");
    expect(clause).toContain("bfSplits.memo ILIKE :bfSearch");
    expect(clause).toContain("bf.payee_id");
    expect(clause).toContain("bf.category_id");
    expect(clause).toContain("bfSplits.category_id");
    expect(clause).toContain("bf.id");
    expect(clause).toContain("bfSplits.id");
    expect(clause).not.toContain(":search");
  });

  it("derives amount/date param names from the search param name", () => {
    const clause = buildTransactionSearchClause({
      transaction: "bf",
      splits: "bfSplits",
      paramName: "bfSearch",
    });

    expect(clause).toContain(":bfSearchAmount");
    expect(clause).toContain(":bfSearchDate");
    expect(clause).not.toContain(":searchAmount");
    expect(clause).not.toContain(":searchDate");
  });

  it("honours explicit amount/date param name overrides", () => {
    const clause = buildTransactionSearchClause({
      transaction: "t",
      splits: "s",
      amountParamName: "amtParam",
      dateParamName: "dateParam",
    });

    expect(clause).toContain("ABS(CAST(:amtParam AS numeric))");
    expect(clause).toContain("CAST(:dateParam AS date)");
  });
});
