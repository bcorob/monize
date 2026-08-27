import { SplitKind } from "../transactions/entities/split-kind.enum";
import {
  applyInvestmentTransactionFilters,
  isEmbeddedInvestmentSplit,
  ordinarySplitLines,
  reportableTransactionAmount,
  brokerageExclusionForEntity,
  brokerageExclusionForSql,
  investmentExclusionSql,
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
} from "./investment-filter.util";

describe("applyInvestmentTransactionFilters", () => {
  it("applies both subtype and NOT EXISTS filters with the default transaction alias", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    const result = applyInvestmentTransactionFilters(qb, "account");

    expect(result).toBe(qb);
    expect(andWhere).toHaveBeenCalledTimes(2);
    expect(andWhere.mock.calls[0][0]).toContain("account.accountSubType");
    expect(andWhere.mock.calls[0][0]).toContain("INVESTMENT_BROKERAGE");
    expect(andWhere.mock.calls[1][0]).toContain("investment_transactions");
    expect(andWhere.mock.calls[1][0]).toContain("transaction.id");
  });

  it("uses a custom transaction alias when provided", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    applyInvestmentTransactionFilters(qb, "acc", "tx");

    expect(andWhere.mock.calls[1][0]).toContain("tx.id");
    expect(andWhere.mock.calls[1][0]).not.toContain("transaction.id");
  });

  it("is composed from the exported fragments, not a second copy of them", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    applyInvestmentTransactionFilters(qb, "acc", "tx");

    expect(andWhere.mock.calls[0][0]).toBe(brokerageExclusionForEntity("acc"));
    expect(andWhere.mock.calls[1][0]).toBe(
      investmentLinkedTransactionExclusion("tx"),
    );
  });
});

describe("brokerage exclusion dialects", () => {
  it("differ only in the column name", () => {
    expect(brokerageExclusionForEntity("a")).toBe(
      "(a.accountSubType IS NULL OR a.accountSubType != 'INVESTMENT_BROKERAGE')",
    );
    expect(brokerageExclusionForSql("a")).toBe(
      "(a.account_sub_type IS NULL OR a.account_sub_type != 'INVESTMENT_BROKERAGE')",
    );
    expect(
      brokerageExclusionForEntity("a").replace(/accountSubType/g, "SUBTYPE"),
    ).toBe(
      brokerageExclusionForSql("a").replace(/account_sub_type/g, "SUBTYPE"),
    );
  });

  // A NULL sub-type is a standalone investment account -- it IS its own cash
  // side, so it must survive the filter.
  it("keeps a NULL sub-type in scope", () => {
    expect(brokerageExclusionForSql("a")).toContain("IS NULL OR");
  });
});

describe("investmentExclusionSql", () => {
  it("emits the brokerage, transaction and split clauses when all aliases are given", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    expect(sql).toContain(brokerageExclusionForSql("a"));
    expect(sql).toContain(investmentLinkedTransactionExclusion("t"));
    expect(sql).toContain(investmentLinkedSplitExclusion("ts"));
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(2);
    expect(sql).toContain("ts.kind IS DISTINCT FROM 'investment'");
  });

  it("omits the split clause when the query joins no splits", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
    });

    expect(sql).not.toContain("transaction_split_id");
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(1);
  });

  it("omits the brokerage clause when no account alias is given", () => {
    const sql = investmentExclusionSql({ transactionAlias: "t" });

    expect(sql).not.toContain("account_sub_type");
    expect(sql).toBe(investmentLinkedTransactionExclusion("t"));
  });

  it("carries no bound parameters, so a caller's $n numbering is unchanged", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    expect(sql).not.toMatch(/\$\d/);
  });

  it("joins its clauses with AND", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    // brokerage, generated cash leg, embedded split kind, embedded split row.
    expect(sql.match(/\bAND\b/g)).toHaveLength(3);
  });

  it("names the split kind from the enum, not a hand-written literal", () => {
    expect(investmentLinkedSplitExclusion("ts")).toContain(
      `IS DISTINCT FROM '${SplitKind.INVESTMENT}'`,
    );
  });

  // A LEFT JOIN that matched no split leaves kind NULL, and `NULL != 'x'` is
  // NULL -- read as false, which would drop every non-split row from the report.
  it("compares the split kind with IS DISTINCT FROM, never !=", () => {
    const clause = investmentLinkedSplitExclusion("ts");

    expect(clause).toContain("ts.kind IS DISTINCT FROM");
    expect(clause).not.toContain("ts.kind !=");
  });

  it("excludes an embedded investment split by both of its representations", () => {
    const clause = investmentLinkedSplitExclusion("ts");

    expect(clause).toContain("ts.kind");
    expect(clause).toContain("its.transaction_split_id = ts.id");
  });

  it("uses distinct sub-query aliases so both NOT EXISTS clauses can coexist", () => {
    expect(investmentLinkedTransactionExclusion("t")).toContain(
      "investment_transactions it ",
    );
    expect(investmentLinkedSplitExclusion("ts")).toContain(
      "investment_transactions its ",
    );
  });
});

/**
 * The hydrated-entity dialect, used by the custom report engine. Same two
 * questions as the SQL fragments: what a line is, and what ordinary cash a whole
 * transaction represents.
 */
describe("isEmbeddedInvestmentSplit", () => {
  it("recognises the declared kind", () => {
    expect(
      isEmbeddedInvestmentSplit({ amount: -500, kind: "investment" }),
    ).toBe(true);
    expect(isEmbeddedInvestmentSplit({ amount: -60, kind: "category" })).toBe(
      false,
    );
  });

  it("recognises a linked investment row on a line that does not declare itself", () => {
    expect(
      isEmbeddedInvestmentSplit({
        amount: -500,
        kind: "category",
        investmentTransaction: { id: "inv-1" },
      }),
    ).toBe(true);
  });

  it("reads a line that hydrated neither field as ordinary", () => {
    // A caller that did not join the relation still gets the `kind` half; a
    // line with neither is an ordinary category line.
    expect(isEmbeddedInvestmentSplit({ amount: -60 })).toBe(false);
  });

  it("uses the same kind value as the SQL fragment", () => {
    expect(
      isEmbeddedInvestmentSplit({ amount: -1, kind: SplitKind.INVESTMENT }),
    ).toBe(true);
  });
});

describe("reportableTransactionAmount", () => {
  const investmentLine = { amount: -500, kind: SplitKind.INVESTMENT };
  const groceries = { amount: -60, kind: SplitKind.CATEGORY };

  it("returns a non-split row's own amount", () => {
    expect(reportableTransactionAmount({ amount: -125, isSplit: false })).toBe(
      -125,
    );
  });

  it("returns the ordinary part of a mixed split, not the parent total", () => {
    expect(
      reportableTransactionAmount({
        amount: -560,
        isSplit: true,
        splits: [groceries, investmentLine],
      }),
    ).toBe(-60);
  });

  it("returns null for a pure investment passthrough", () => {
    // Not zero: the row represents no ordinary cash, which a caller drops
    // rather than adding 0 to a bucket.
    expect(
      reportableTransactionAmount({
        amount: -500,
        isSplit: true,
        splits: [investmentLine],
      }),
    ).toBeNull();
  });

  it("keeps a transfer line, because that decision belongs to the caller", () => {
    // The SQL twin drops transfer children; a custom report carries its own
    // includeTransfers configuration and narrows the lines itself before calling
    // this, so this one leaves whatever it is given alone.
    expect(
      reportableTransactionAmount({
        amount: -260,
        isSplit: true,
        splits: [groceries, { amount: -200, kind: SplitKind.TRANSFER }],
      }),
    ).toBe(-260);
  });

  it("answers null for a hydrated split parent with no lines, as the SQL twin does", () => {
    // `SUM` over no rows is NULL there, so it is null here.
    expect(
      reportableTransactionAmount({ amount: -560, isSplit: true, splits: [] }),
    ).toBeNull();
  });

  it("falls back to the parent amount when the caller did not hydrate the lines", () => {
    // Absent is not a fact about the transaction: answering null would hide real
    // money from a caller that simply did not select splits.
    expect(reportableTransactionAmount({ amount: -560, isSplit: true })).toBe(
      -560,
    );
    expect(
      reportableTransactionAmount({
        amount: -560,
        isSplit: true,
        splits: null,
      }),
    ).toBe(-560);
  });

  it("sums in integer arithmetic, so 4dp lines do not drift", () => {
    expect(
      reportableTransactionAmount({
        amount: -0.3,
        isSplit: true,
        splits: [{ amount: -0.1 }, { amount: -0.2 }],
      }),
    ).toBe(-0.3);
  });

  it("reads amounts that arrive as decimal strings", () => {
    expect(
      reportableTransactionAmount({
        amount: "-560.0000",
        isSplit: true,
        splits: [
          { amount: "-60.0000", kind: SplitKind.CATEGORY },
          { amount: "-500.0000", kind: SplitKind.INVESTMENT },
        ],
      }),
    ).toBe(-60);
  });
});

describe("ordinarySplitLines", () => {
  it("drops only the investment lines and keeps their siblings", () => {
    const groceries = { amount: -60, kind: SplitKind.CATEGORY };
    const transfer = { amount: -200, kind: SplitKind.TRANSFER };
    const investment = { amount: -500, kind: SplitKind.INVESTMENT };

    expect(
      ordinarySplitLines({ splits: [groceries, transfer, investment] }),
    ).toEqual([groceries, transfer]);
  });

  it("answers an empty list for a transaction with no splits", () => {
    expect(ordinarySplitLines({})).toEqual([]);
    expect(ordinarySplitLines({ splits: null })).toEqual([]);
  });
});
