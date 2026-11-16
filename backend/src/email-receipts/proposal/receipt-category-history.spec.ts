import type { EntityManager } from "typeorm";
import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import { buildReceiptProposal } from "./build-receipt-proposal";
import {
  applyCategoryHistory,
  itemHistoryKey,
  loadItemCategoryHistory,
} from "./receipt-category-history";

const RULE_CAT = "11111111-1111-4111-8111-111111111111";
const HIST_CAT = "22222222-2222-4222-8222-222222222222";
const GONE = "99999999-9999-4999-8999-999999999999";
const CATEGORIES: ReadonlyMap<string, string> = new Map([
  [RULE_CAT, "Shopping"],
  [HIST_CAT, "Food"],
]);

const parsed = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  orderId: null,
  total: 150000,
  paid: null,
  payee: null,
  shipping: null,
  discount: null,
  items: [
    { name: "Milk 1L", qty: 1, amount: 100000, categoryId: RULE_CAT },
    { name: "Mystery", qty: 1, amount: 50000, categoryId: null },
  ],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: false,
  reason: "items_uncategorized",
  ...over,
});

describe("itemHistoryKey", () => {
  it("ignores case and runs of whitespace", () => {
    expect(itemHistoryKey("  Milk   1L ")).toBe("milk 1l");
  });
});

describe("loadItemCategoryHistory", () => {
  const manager = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { m: { query } as unknown as EntityManager, query };
  };

  it("reads once, scoped to the user, with parameters only", async () => {
    const { m, query } = manager([{ key: "milk 1l", category_id: HIST_CAT }]);
    const map = await loadItemCategoryHistory(m, "user-1", [
      "Milk 1L",
      "MILK  1L",
    ]);
    expect(map.get("milk 1l")).toBe(HIST_CAT);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("t.user_id = $1");
    expect(sql).not.toContain("Milk");
    expect(params).toEqual(["user-1", ["milk 1l"]]);
  });

  it("makes no query without a name", async () => {
    const { m, query } = manager([]);
    expect((await loadItemCategoryHistory(m, "u", ["  "])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("applyCategoryHistory", () => {
  const history = new Map([["milk 1l", HIST_CAT]]);

  it("history wins over the category a rule gave", () => {
    const out = applyCategoryHistory(parsed(), history, CATEGORIES);
    expect(out.items[0]).toMatchObject({
      categoryId: HIST_CAT,
      categorySource: "history",
    });
  });

  it("leaves an item with no history to the rules, or to the AI when bare", () => {
    const out = applyCategoryHistory(parsed(), history, CATEGORIES);
    expect(out.items[1].categoryId).toBeNull();
    expect(out.reason).toBe("items_uncategorized");
  });

  it("judges completeness again when history categorises the last bare item", () => {
    const out = applyCategoryHistory(
      parsed(),
      new Map([
        ["milk 1l", HIST_CAT],
        ["mystery", HIST_CAT],
      ]),
      CATEGORIES,
    );
    expect(out.complete).toBe(true);
    expect(out.reason).toBeNull();
  });

  it("ignores a category the user no longer has", () => {
    const out = applyCategoryHistory(
      parsed(),
      new Map([["milk 1l", GONE]]),
      CATEGORIES,
    );
    expect(out.items[0].categoryId).toBe(RULE_CAT);
  });

  it("does not rewrite a reason that is not about categories", () => {
    const out = applyCategoryHistory(
      parsed({ reason: "items_unbalanced" }),
      new Map([["mystery", HIST_CAT]]),
      CATEGORIES,
    );
    expect(out.reason).toBe("items_unbalanced");
    expect(out.complete).toBe(false);
  });

  it("returns the same reading when nothing changes", () => {
    const input = parsed();
    expect(applyCategoryHistory(input, new Map(), CATEGORIES)).toBe(input);
  });

  it("the proposal built from a history-categorised reading is itemized", () => {
    const out = applyCategoryHistory(
      parsed(),
      new Map([
        ["milk 1l", HIST_CAT],
        ["mystery", RULE_CAT],
      ]),
      CATEGORIES,
    );
    const proposal = buildReceiptProposal(
      out,
      { amount: -15, description: null, payeeId: null, referenceNumber: null },
      { parserName: "Shop", payeeName: null, categoryNames: CATEGORIES },
    );
    expect(proposal.kind).toBe("itemized");
    expect(proposal.input?.splits?.map((s) => s.categoryName)).toEqual([
      "Food",
      "Shopping",
    ]);
  });
});
