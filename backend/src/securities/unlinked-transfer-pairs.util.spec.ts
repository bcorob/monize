import {
  TRANSFER_LEG_PAIRS,
  toUnlinkedTransferPairs,
  unlinkedTransferPairsSql,
} from "./unlinked-transfer-pairs.util";

/**
 * What makes two rows a CANDIDATE, asserted on the statement rather than on a
 * database: the shape of the predicate is the whole claim, and a condition
 * quietly dropped from it would offer a reader a pairing that is not one.
 */
describe("unlinkedTransferPairsSql", () => {
  const sql = unlinkedTransferPairsSql();

  it("names both leg pairings, and in the right direction", () => {
    // An ADD_SHARES answers a REMOVE_SHARES for the reason a TRANSFER_IN
    // answers a TRANSFER_OUT: one ledger's units left and another's arrived.
    expect(sql).toContain(
      "o.action = 'TRANSFER_OUT' AND i.action = 'TRANSFER_IN'",
    );
    expect(sql).toContain(
      "o.action = 'REMOVE_SHARES' AND i.action = 'ADD_SHARES'",
    );
    // Never the other way round on one row: the join is one-directional, so a
    // pair comes back once rather than twice.
    expect(sql).not.toContain("o.action = 'TRANSFER_IN'");
  });

  it("requires one security, one day and the same shares", () => {
    expect(sql).toContain("i.security_id = o.security_id");
    expect(sql).toContain("i.transaction_date = o.transaction_date");
    expect(sql).toContain("ABS(i.quantity) = ABS(o.quantity)");
  });

  it("matches on absolute quantity, because a leg's sign is its action's", () => {
    // TRANSFER_OUT and REMOVE_SHARES are both recorded positive.
    expect(sql).toContain("ABS(i.quantity) = ABS(o.quantity)");
    expect(sql).toContain("COALESCE(o.quantity, 0) <> 0");
  });

  it("wants two different accounts, both of the scope it was given", () => {
    expect(sql).toContain("i.account_id <> o.account_id");
    expect(sql).toContain("o.account_id = ANY($2::UUID[])");
    expect(sql).toContain("i.account_id = ANY($2::UUID[])");
  });

  it("leaves out a leg that is already paired", () => {
    // Somebody's pairing, not ours to replace.
    expect(sql).toContain("o.linked_transaction_id IS NULL");
    expect(sql).toContain("i.linked_transaction_id IS NULL");
  });

  it("reads both legs as effects, so a void row is half of nothing", () => {
    expect(sql).toContain("o.status != 'VOID'");
    expect(sql).toContain("i.status != 'VOID'");
  });

  it("scopes to the one user, parameterized", () => {
    expect(sql).toContain("o.user_id = $1");
    expect(sql).toContain("i.user_id = o.user_id");
    expect(sql).not.toMatch(/user_id\s*=\s*'/);
  });
});

describe("TRANSFER_LEG_PAIRS", () => {
  it("names the releasing leg first, as the write path reads it", () => {
    expect(TRANSFER_LEG_PAIRS).toEqual([
      ["TRANSFER_OUT", "TRANSFER_IN"],
      ["REMOVE_SHARES", "ADD_SHARES"],
    ]);
  });
});

describe("toUnlinkedTransferPairs", () => {
  it("coerces the driver's numeric strings at this boundary", () => {
    const [pair] = toUnlinkedTransferPairs([
      {
        security_id: "sec-1",
        symbol: "HUDCE",
        security_name: "A fund",
        transaction_date: "2020-01-20",
        quantity: "1140.00000000",
        out_transaction_id: "tx-out",
        out_account_id: "acct-ca",
        out_account_name: "CA RRSP",
        in_transaction_id: "tx-in",
        in_account_id: "acct-us",
        in_account_name: "US RRSP",
      },
    ]);

    expect(pair).toEqual({
      securityId: "sec-1",
      symbol: "HUDCE",
      securityName: "A fund",
      transactionDate: "2020-01-20",
      quantity: 1140,
      out: {
        transactionId: "tx-out",
        accountId: "acct-ca",
        accountName: "CA RRSP",
      },
      in: {
        transactionId: "tx-in",
        accountId: "acct-us",
        accountName: "US RRSP",
      },
    });
  });

  it("reports a security with no symbol as having none, never as a blank", () => {
    const [pair] = toUnlinkedTransferPairs([
      {
        security_id: "sec-1",
        symbol: null,
        security_name: null,
        transaction_date: "2020-01-20",
        quantity: 5,
        out_transaction_id: "a",
        out_account_id: "b",
        out_account_name: "One",
        in_transaction_id: "c",
        in_account_id: "d",
        in_account_name: "Two",
      },
    ]);

    expect(pair.symbol).toBeNull();
    expect(pair.securityName).toBeNull();
  });
});
