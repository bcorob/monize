import { loadFirstInvestmentDate } from "./investment-inception.util";

describe("loadFirstInvestmentDate", () => {
  it("asks nothing and answers null for an empty scope", async () => {
    const query = jest.fn();

    await expect(loadFirstInvestmentDate(query, "user-1", [])).resolves.toBe(
      null,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("returns the earliest effective investment date for the scope", async () => {
    const query = jest.fn().mockResolvedValue([{ date: "2021-03-04" }]);

    await expect(
      loadFirstInvestmentDate(query, "user-1", ["acct-1", "acct-2"]),
    ).resolves.toBe("2021-03-04");

    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(["user-1", ["acct-1", "acct-2"]]);
    // A void row records something that did not happen, so it cannot be the
    // day a portfolio started.
    expect(sql).toMatch(/VOID/);
    expect(sql).toMatch(/TO_CHAR\(MIN\(it\.transaction_date\)/);
  });

  it("answers null when the scope holds no investment transaction", async () => {
    const query = jest.fn().mockResolvedValue([{ date: null }]);

    await expect(
      loadFirstInvestmentDate(query, "user-1", ["acct-1"]),
    ).resolves.toBe(null);
  });
});
