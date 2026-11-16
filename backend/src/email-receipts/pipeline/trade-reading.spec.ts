import { Security } from "../../securities/entities/security.entity";
import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
  WEALTHSIMPLE_TRADE_DEFINITION,
} from "../parsing/fixtures/wealthsimple-trade";
import { normalizeReceiptLines } from "../parsing/receipt-lines";
import type { ReceiptTradeDefinition } from "../parsing/receipt-parser.types";
import { readTradeEmail } from "./trade-reading";

const USER = "user-1";
const RRSP_USD = "33333333-3333-4333-8333-333333333333";
const byCurrency: ReceiptTradeDefinition = {
  ...(WEALTHSIMPLE_TRADE_DEFINITION.trade as ReceiptTradeDefinition),
  accountRules: [
    { match: "RRSP", currency: "USD", accountId: RRSP_USD },
    { match: "RRSP", currency: "CAD", accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
  ],
};

/** A manager whose securities lookup returns the listings of `currencies`, one per currency. */
function managerListing(currencies: string[]) {
  const builder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () =>
      currencies.map((code, i) =>
        Object.assign(new Security(), {
          id: `sec-${i}`,
          symbol: i === 0 ? "XCNS" : `XCNS.${i}`,
          currencyCode: code,
        }),
      ),
    ),
  };
  const repository = { createQueryBuilder: jest.fn(() => builder) };
  return {
    manager: { getRepository: jest.fn(() => repository) },
    builder,
  };
}

const read = (definition: ReceiptTradeDefinition, manager: unknown) =>
  readTradeEmail(
    manager as never,
    USER,
    definition,
    normalizeReceiptLines(WEALTHSIMPLE_BUY_BODY),
  );

describe("readTradeEmail", () => {
  it("decides the account by the security's currency when the email names none", async () => {
    const { manager, builder } = managerListing(["CAD"]);
    const { trade } = await read(byCurrency, manager);
    expect(trade).toMatchObject({
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      currency: "CAD",
      currencySource: "security",
      complete: true,
    });
    expect(builder.where).toHaveBeenCalledWith("security.userId = :userId", {
      userId: USER,
    });
  });

  it("never guesses when the ticker's listings trade in two currencies", async () => {
    const { manager } = managerListing(["CAD", "USD"]);
    const { trade } = await read(byCurrency, manager);
    expect(trade).toMatchObject({
      accountId: null,
      complete: false,
      reason: "trade_no_currency",
    });
  });

  it("does not look the security up when the rules need no currency", async () => {
    const { manager } = managerListing(["CAD"]);
    const { trade } = await read(
      WEALTHSIMPLE_TRADE_DEFINITION.trade as ReceiptTradeDefinition,
      manager,
    );
    expect(trade.accountId).toBe(WEALTHSIMPLE_RRSP_ACCOUNT_ID);
    expect(manager.getRepository).not.toHaveBeenCalled();
  });
});
