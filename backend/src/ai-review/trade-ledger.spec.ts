import {
  emailDayOfUser,
  findTradeInLedger,
  recordTradeBooking,
} from "./trade-ledger";

const USER = "user-1";
const trade = {
  accountId: "acc-1",
  action: "BUY" as const,
  quantity: 75.9878 as number | null,
  totalAmount: 2000,
  date: "2026-10-15",
};

function manager(rows: unknown[] = []) {
  return { query: jest.fn(async (..._args: unknown[]) => rows) };
}

describe("findTradeInLedger", () => {
  it("is a duplicate only through a matching row no other email accounts for", async () => {
    const m = manager([
      { id: "it-1", claimed: true },
      { id: "it-2", claimed: false },
    ]);
    await expect(
      findTradeInLedger(m as never, USER, { ...trade, symbol: "XCNS" }, "r-1"),
    ).resolves.toEqual({ unclaimedId: "it-2", anyMatch: true });
  });

  it("a row another email accounts for is a second identical fill, not a duplicate", async () => {
    const m = manager([{ id: "it-1", claimed: true }]);
    await expect(
      findTradeInLedger(m as never, USER, { ...trade, symbol: "XCNS" }, "r-1"),
    ).resolves.toEqual({ unclaimedId: null, anyMatch: true });
  });

  it("matches the ticker or its listings, VOID rows excepted, and leaves this email's own row out of 'another's'", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, symbol: "X_NS" },
      "r-1",
    );
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("it.status != 'VOID'");
    expect(sql).toContain("r.id IS DISTINCT FROM $8::uuid");
    expect(params).toEqual([
      USER,
      "acc-1",
      "BUY",
      "2026-10-15",
      "75.9878",
      "X_NS",
      "X\\_NS.%",
      "r-1",
      null,
      true,
      "2000",
    ]);
  });

  it("matches the exact security when given one (the confirm, after resolution)", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, action: "SELL", securityId: "sec-1" },
      null,
    );
    const [, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      USER,
      "acc-1",
      "SELL",
      "2026-10-15",
      "75.9878",
      null,
      null,
      null,
      "sec-1",
      true,
      "2000",
    ]);
  });

  it("tells a reinvested dividend apart by its shares, as a buy", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, action: "REINVEST", securityId: "sec-1" },
      null,
    );
    const [, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("REINVEST");
    expect(params[4]).toBe("75.9878");
    expect(params[9]).toBe(true);
  });

  it("tells a cash dividend apart by its amount: it moves no shares, and its row may store a quantity of 0", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      {
        ...trade,
        action: "DIVIDEND",
        quantity: null,
        totalAmount: 12.34,
        securityId: "sec-1",
      },
      "r-1",
    );
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ELSE it.total_amount = $11::numeric END");
    expect(params).toEqual([
      USER,
      "acc-1",
      "DIVIDEND",
      "2026-10-15",
      null,
      null,
      null,
      "r-1",
      "sec-1",
      false,
      "12.34",
    ]);
  });

  it("counts the same day's reinvestment of a dividend as a match, so a DRIP's payout email never auto-applies beside it", async () => {
    const m = {
      query: jest.fn(async (sql: string) =>
        String(sql).includes("claimed") ? [] : [{ id: "it-drip" }],
      ),
    };
    await expect(
      findTradeInLedger(
        m as never,
        USER,
        { ...trade, action: "DIVIDEND", quantity: null, securityId: "sec-1" },
        "r-1",
      ),
    ).resolves.toEqual({ unclaimedId: null, anyMatch: true });
    const [, params] = m.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(params).toEqual([
      USER,
      "acc-1",
      "REINVEST",
      "2026-10-15",
      null,
      null,
      "sec-1",
    ]);
  });

  it("asks for no payout twin of a buy", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, symbol: "XCNS" },
      null,
    );
    expect(m.query).toHaveBeenCalledTimes(1);
  });

  it("a dividend email stating the shares still compares the amount, not a share count the ledger may not hold", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, action: "DIVIDEND", securityId: "sec-1" },
      null,
    );
    const [, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBeNull();
    expect(params[9]).toBe(false);
  });
});

describe("recordTradeBooking", () => {
  it("writes the row on the request's own email, bound to the user", async () => {
    const m = manager();
    await recordTradeBooking(m as never, USER, "rq-1", "it-1");
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET investment_transaction_id = $3");
    expect(sql).toContain("r.id = q.email_receipt_id");
    expect(sql).toContain("q.user_id = $1");
    expect(params).toEqual([USER, "rq-1", "it-1"]);
  });
});

describe("emailDayOfUser", () => {
  const sent = new Date("2026-10-16T01:30:00Z");

  it("is the day in the user's timezone", async () => {
    const m = manager([
      { timezone: "America/Toronto", last_client_timezone: null },
    ]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-15",
    );
  });

  it("falls back to the browser's last timezone, then UTC", async () => {
    let m = manager([
      { timezone: "browser", last_client_timezone: "America/Vancouver" },
    ]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-15",
    );
    m = manager([]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-16",
    );
  });
});
