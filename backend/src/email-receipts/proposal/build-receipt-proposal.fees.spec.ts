import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import { buildReceiptProposal } from "./build-receipt-proposal";

const CAT_ITEM = "11111111-1111-4111-8111-111111111111";
const CAT_FEES = "55555555-5555-4555-8555-555555555555";
const CAT_SHIP = "44444444-4444-4444-8444-444444444444";

const CTX = {
  parserName: "Shop",
  payeeName: null,
  categoryNames: new Map([
    [CAT_ITEM, "Food"],
    [CAT_FEES, "Fees"],
    [CAT_SHIP, "Postage"],
  ]) as ReadonlyMap<string, string>,
};
const tx = (amount: number) => ({
  amount,
  description: "x",
  payeeId: null,
  referenceNumber: null,
});

const receipt = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  orderId: null,
  total: 117500,
  paid: null,
  payee: null,
  shipping: null,
  fees: [5000, 12500],
  feesCategoryId: CAT_FEES,
  discount: null,
  items: [{ name: "Pen", qty: 1, amount: 100000, categoryId: CAT_ITEM }],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: true,
  reason: null,
  ...over,
});

describe("fees as split lines", () => {
  it("each fee is its own line under the fees category, after shipping", () => {
    const p = buildReceiptProposal(
      receipt({ shipping: 10000, shippingCategoryId: CAT_SHIP, total: 127500 }),
      tx(-12.75),
      CTX,
    );
    expect(p.kind).toBe("itemized");
    expect(p.input?.splits?.map((s) => [s.categoryName, s.amount])).toEqual([
      ["Food", -10],
      ["Postage", -1],
      ["Fees", -0.5],
      ["Fees", -1.25],
    ]);
  });

  it("a fee line has the sign of the transaction", () => {
    const p = buildReceiptProposal(receipt(), tx(11.75), CTX);
    expect(p.input?.splits?.map((s) => s.amount)).toEqual([10, 0.5, 1.25]);
  });

  it("a zero fee makes no line", () => {
    const p = buildReceiptProposal(
      receipt({ fees: [0, 5000], total: 105000 }),
      tx(-10.5),
      CTX,
    );
    expect(p.input?.splits).toHaveLength(2);
  });

  it("a fee category the user no longer has is category_missing", () => {
    const p = buildReceiptProposal(
      receipt({ feesCategoryId: "99999999-9999-4999-8999-999999999999" }),
      tx(-11.75),
      CTX,
    );
    expect(p.reason).toBe("category_missing");
  });
});

describe("balanceTolerance in the split", () => {
  const off = (over: Partial<ParsedReceipt>) =>
    receipt({
      fees: [],
      items: [
        { name: "Pen", qty: 1, amount: 100000, categoryId: CAT_ITEM },
        { name: "Ink", qty: 1, amount: 50000, categoryId: CAT_ITEM },
      ],
      total: 150100,
      paid: 150100,
      ...over,
    });

  it("adds the difference to the last line so the split sums to the transaction", () => {
    const p = buildReceiptProposal(
      off({ balanceTolerance: 100 }),
      tx(-15.01),
      CTX,
    );
    expect(p.kind).toBe("itemized");
    expect(p.input?.splits?.map((s) => s.amount)).toEqual([-10, -5.01]);
  });

  it("works for a negative difference and a positive transaction", () => {
    const p = buildReceiptProposal(
      off({ total: 149900, paid: 149900, balanceTolerance: 100 }),
      tx(14.99),
      CTX,
    );
    expect(p.input?.splits?.map((s) => s.amount)).toEqual([10, 4.99]);
  });

  it("refuses a difference above the tolerance", () => {
    const p = buildReceiptProposal(
      off({ balanceTolerance: 50 }),
      tx(-15.01),
      CTX,
    );
    expect(p.kind).toBe("description_only");
    expect(p.reason).toBe("amount_differs");
  });

  it("without a tolerance the difference is refused as before", () => {
    const p = buildReceiptProposal(off({}), tx(-15.01), CTX);
    expect(p.reason).toBe("amount_differs");
  });

  it("never turns the last line into its opposite", () => {
    const p = buildReceiptProposal(
      off({
        items: [
          { name: "Pen", qty: 1, amount: 100000, categoryId: CAT_ITEM },
          { name: "Ink", qty: 1, amount: 100, categoryId: CAT_ITEM },
        ],
        total: 99800,
        paid: 99800,
        balanceTolerance: 500,
      }),
      tx(-9.98),
      CTX,
    );
    expect(p.reason).toBe("amount_differs");
  });
});
