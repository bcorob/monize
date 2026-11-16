import { NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { loadBondLedger, loadLinkedSecurity } from "./bond-ledger";
import { bondLotsFromTransactions } from "./bond-lots";

const USER = "user-1";
const SEC = "sec-1";
const PROGRAM = "prog-1";
const EDO = "11111111-1111-5111-8111-111111111111";

interface Row {
  id: string;
  action: string;
  tx_date: string;
  quantity: string;
  bond_instrument_id: string | null;
  counterpart_account_id?: string | null;
}

function manager(
  rows: Row[],
  opts: { onSale?: string[]; linked?: boolean } = {},
) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("bond_auto_fetch")) {
      return opts.linked === false
        ? []
        : [
            {
              id: SEC,
              user_id: USER,
              symbol: "EDO",
              currency_code: "PLN",
              bond_program_id: PROGRAM,
              bond_auto_fetch: false,
            },
          ];
    }
    if (sql.includes("counterpart_account_id")) {
      return rows.map((r) => ({
        status: "UNRECONCILED",
        account_id: "acc-1",
        counterpart_account_id: null,
        ...r,
      }));
    }
    if (sql.includes("saleWindow"))
      return (opts.onSale ?? []).map((id) => ({ id }));
    return [];
  });
  return { m: { query } as unknown as EntityManager, query };
}

const saleQueries = (query: jest.Mock) =>
  query.mock.calls.filter(([sql]) => String(sql).includes("saleWindow"));

describe("loadBondLedger: the series each row is read as (INV-BOND-007)", () => {
  it("carries the id of every row, so a refusal can name the row", async () => {
    const { m } = manager([
      {
        id: "b1",
        action: "BUY",
        tx_date: "2026-01-10",
        quantity: "5",
        bond_instrument_id: EDO,
      },
    ]);
    const ledger = await loadBondLedger(m, USER, SEC);
    expect(ledger.transactions[0]).toMatchObject({
      id: "b1",
      instrumentId: EDO,
    });
  });

  it("reads a BUY or REINVEST with no stored series as the series on sale on its date", async () => {
    const { m } = manager(
      [
        {
          id: "b1",
          action: "BUY",
          tx_date: "2026-01-10",
          quantity: "5",
          bond_instrument_id: null,
        },
        {
          id: "r1",
          action: "REINVEST",
          tx_date: "2026-01-10",
          quantity: "1",
          bond_instrument_id: null,
        },
      ],
      { onSale: [EDO] },
    );
    const ledger = await loadBondLedger(m, USER, SEC);
    expect(ledger.transactions.map((t) => t.instrumentId)).toEqual([EDO, EDO]);
  });

  it("never infers the series of an ADD_SHARES or an unpaired TRANSFER_IN: the lots name the row (SERIES_NOT_DETERMINED)", async () => {
    for (const action of ["ADD_SHARES", "TRANSFER_IN"]) {
      const { m, query } = manager(
        [
          {
            id: "x1",
            action,
            tx_date: "2026-01-10",
            quantity: "5",
            bond_instrument_id: null,
          },
        ],
        { onSale: [EDO] },
      );
      const ledger = await loadBondLedger(m, USER, SEC);
      expect(ledger.transactions[0].instrumentId).toBeNull();
      expect(saleQueries(query)).toHaveLength(0);
      expect(
        bondLotsFromTransactions(ledger.transactions).refusal,
      ).toMatchObject({
        code: "SERIES_NOT_DETERMINED",
        rowId: "x1",
      });
    }
  });

  it("a stored series is used for any acquisition, and the in-leg of a pair names none", async () => {
    const { m } = manager([
      {
        id: "a1",
        action: "ADD_SHARES",
        tx_date: "2026-01-10",
        quantity: "5",
        bond_instrument_id: EDO,
      },
      {
        id: "t1",
        action: "TRANSFER_IN",
        tx_date: "2026-01-11",
        quantity: "1",
        bond_instrument_id: null,
        counterpart_account_id: "acc-9",
      },
    ]);
    const ledger = await loadBondLedger(m, USER, SEC);
    expect(ledger.transactions.map((t) => t.instrumentId)).toEqual([EDO, null]);
  });
});

describe("loadLinkedSecurity", () => {
  it("is a 404 for a security that is missing, another user's or not linked", async () => {
    await expect(
      loadLinkedSecurity(manager([], { linked: false }).m, USER, SEC),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
