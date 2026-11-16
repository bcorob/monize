import { EntityManager } from "typeorm";
import { datedLoanDebt, datedLoanDebts } from "./dated-loan-debt.util";
import {
  ACCOUNT_BALANCE_AS_OF_SQL,
  ACCOUNT_BALANCES_AS_OF_DATES_SQL,
  LEDGER_BALANCE_EXPRESSION,
  LEDGER_MOVEMENT_PREDICATE,
  ledgerBalanceJoin,
} from "../common/ledger-balance.sql";

/**
 * `datedLoanDebts` is `datedLoanDebt` for several dates in one statement
 * (`docs/specs/loan-installment-settlement.md` section 7.1). The property
 * that matters -- equal date by date on a real ledger -- is proved by
 * `test/integration/loan-settlement-debt.integration.spec.ts`; this spec holds
 * the two to one spelling of the as-of balance, and checks the mapping of
 * what PostgreSQL returns into debts.
 */
describe("datedLoanDebts", () => {
  const loan = { id: "acc-loan", userId: "user-1" };
  let query: jest.Mock;
  const manager = () => ({ query }) as unknown as EntityManager;

  beforeEach(() => {
    query = jest.fn();
  });

  it("is built from the same join and expression as the single-date query", () => {
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      LEDGER_BALANCE_EXPRESSION,
    );
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      ledgerBalanceJoin("d.as_of"),
    );
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      LEDGER_MOVEMENT_PREDICATE,
    );
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain("unnest($3::date[])");
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      "TO_CHAR(d.as_of, 'YYYY-MM-DD')",
    );
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      "a.id = $1 AND a.user_id = $2",
    );
    // The single-date query is the batched one bounded at one parameter.
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(ledgerBalanceJoin("$3"));
  });

  it("asks for every distinct date once and maps each row to a debt", async () => {
    query.mockResolvedValue([
      { as_of: "2024-01-01", balance: "-300000.0000" },
      { as_of: "2024-02-01", balance: "-299166.6700" },
    ]);
    const debts = await datedLoanDebts(manager(), loan, [
      "2024-01-01",
      "2024-02-01",
      "2024-01-01",
    ]);
    expect(query).toHaveBeenCalledWith(ACCOUNT_BALANCES_AS_OF_DATES_SQL, [
      "acc-loan",
      "user-1",
      ["2024-01-01", "2024-02-01"],
    ]);
    expect(debts).toEqual(
      new Map([
        ["2024-01-01", 300000],
        ["2024-02-01", 299166.67],
      ]),
    );
  });

  it("reads a balance in credit as retired, not as fresh debt", async () => {
    query.mockResolvedValue([{ as_of: "2024-01-01", balance: "12.5000" }]);
    expect(await datedLoanDebts(manager(), loan, ["2024-01-01"])).toEqual(
      new Map([["2024-01-01", 0]]),
    );
  });

  it("answers an empty map for no dates without touching the database", async () => {
    expect(await datedLoanDebts(manager(), loan, [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("answers null, not zeros, when the account row cannot be read", async () => {
    query.mockResolvedValue([]);
    expect(await datedLoanDebts(manager(), loan, ["2024-01-01"])).toBeNull();
  });

  it("answers null when a date asked for came back without a balance", async () => {
    query.mockResolvedValue([{ as_of: "2024-01-01", balance: null }]);
    expect(
      await datedLoanDebts(manager(), loan, ["2024-01-01", "2024-02-01"]),
    ).toBeNull();
    query.mockResolvedValue([{ as_of: "2024-01-01", balance: "-1.0000" }]);
    expect(
      await datedLoanDebts(manager(), loan, ["2024-01-01", "2024-02-01"]),
    ).toBeNull();
  });

  it("agrees with datedLoanDebt on the same balance", async () => {
    query.mockResolvedValue([{ balance: "-299166.6700" }]);
    const single = await datedLoanDebt(manager(), loan, "2024-02-01");
    query.mockResolvedValue([{ as_of: "2024-02-01", balance: "-299166.6700" }]);
    const batched = await datedLoanDebts(manager(), loan, ["2024-02-01"]);
    expect(batched?.get("2024-02-01")).toBe(single);
  });
});
