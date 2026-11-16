import {
  MAX_STORED_CANDIDATES,
  RECEIPT_MATCH_DAYS_AFTER,
  RECEIPT_MATCH_DAYS_BEFORE,
  ReceiptMatchCandidate,
  matchReceipt,
  receiptCandidateWindow,
} from "./match-receipt";
import { DEFAULT_MATCH_CONFIG } from "../parsing/receipt-match-config";

const RECEIVED = "2026-03-10";
const PAYEE = "payee-shop";
const OTHER_PAYEE = "payee-other";

let counter = 0;
/** A candidate that signals nothing unless the test gives it a reason to. */
const tx = (
  over: Partial<ReceiptMatchCandidate> = {},
): ReceiptMatchCandidate => {
  counter += 1;
  return {
    id: `tx-${String(counter).padStart(3, "0")}`,
    transactionDate: RECEIVED,
    amount: -99.99,
    payeeId: OTHER_PAYEE,
    payeeName: "Corner Store",
    description: null,
    referenceNumber: null,
    ...over,
  };
};

// 37.97 in 1/10000 units.
const TOTAL = 379700;
const amount = (over: Partial<ReceiptMatchCandidate> = {}) =>
  tx({ amount: -37.97, ...over });

const match = (
  candidates: ReceiptMatchCandidate[],
  parsed: {
    orderId: string | null;
    total: number | null;
    paid?: number | null;
    payee?: string | null;
  } = {
    orderId: "EX-20931",
    total: TOTAL,
  },
  payeeId: string | null = PAYEE,
) => matchReceipt(parsed, RECEIVED, candidates, payeeId);

describe("receiptCandidateWindow", () => {
  it("is received minus 3 days to received plus 14 days", () => {
    expect(RECEIPT_MATCH_DAYS_BEFORE).toBe(3);
    expect(RECEIPT_MATCH_DAYS_AFTER).toBe(14);
    expect(MAX_STORED_CANDIDATES).toBe(10);
    expect(receiptCandidateWindow("2026-03-10")).toEqual({
      from: "2026-03-07",
      to: "2026-03-24",
    });
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(receiptCandidateWindow("2026-01-02")).toEqual({
      from: "2025-12-30",
      to: "2026-01-16",
    });
    expect(receiptCandidateWindow("2028-02-20")).toEqual({
      from: "2028-02-17",
      to: "2028-03-05",
    });
  });
});

describe("matchReceipt: the spec section 3 truth table", () => {
  it("row 1: exactly one candidate with O matches by order id (A and P elsewhere do not matter)", () => {
    const o = tx({ description: "Payment ref EX-20931" });
    const ap = amount({ payeeId: PAYEE });
    expect(match([ap, o])).toMatchObject({
      kind: "matched",
      transactionId: o.id,
      matchKind: "order_id",
    });
  });

  it("row 2: two or more candidates with O are ambiguous (the O set)", () => {
    const o1 = tx({ description: "ex-20931 web" });
    const o2 = tx({ payeeName: "Shop EX-20931" });
    const ap = amount({ payeeId: PAYEE });
    expect(match([ap, o1, o2])).toMatchObject({
      kind: "ambiguous",
      candidateIds: [o1.id, o2.id],
    });
  });

  it("row 3: no O, exactly one A and P matches by amount and payee (A only ones do not matter)", () => {
    const ap = amount({ payeeId: PAYEE });
    const aOnly1 = amount();
    const aOnly2 = amount();
    expect(match([aOnly1, ap, aOnly2])).toMatchObject({
      kind: "matched",
      transactionId: ap.id,
      matchKind: "amount_payee",
    });
  });

  it("row 4: no O, two or more A and P are ambiguous (the A and P set)", () => {
    const ap1 = amount({ payeeId: PAYEE });
    const ap2 = amount({ payeeId: PAYEE });
    const aOnly = amount();
    expect(match([aOnly, ap1, ap2])).toMatchObject({
      kind: "ambiguous",
      candidateIds: [ap1.id, ap2.id],
    });
  });

  it("row 5: no O, no A and P, exactly one A matches by amount only", () => {
    const a = amount();
    const noise = tx({ payeeId: PAYEE });
    expect(match([noise, a])).toMatchObject({
      kind: "matched",
      transactionId: a.id,
      matchKind: "amount_date",
    });
  });

  it("row 6: no O, no A and P, two or more A are ambiguous (the A set)", () => {
    const a1 = amount();
    const a2 = amount();
    expect(match([a1, tx(), a2])).toMatchObject({
      kind: "ambiguous",
      candidateIds: [a1.id, a2.id],
    });
  });

  it("row 7: nothing matches", () => {
    expect(match([tx(), tx({ payeeId: PAYEE })])).toMatchObject({
      kind: "unmatched",
    });
    expect(match([])).toMatchObject({ kind: "unmatched" });
  });
});

describe("matchReceipt: the order id signal (O)", () => {
  const withDescription = (description: string) => tx({ description });

  it.each([
    ["description", (id: string) => tx({ description: `Order ${id} paid` })],
    ["payee name", (id: string) => tx({ payeeName: `Shop ${id}` })],
    ["reference number", (id: string) => tx({ referenceNumber: id })],
  ])("finds the id in the %s", (_label, make) => {
    const candidate = make("EX-20931");
    expect(match([candidate])).toMatchObject({
      kind: "matched",
      transactionId: candidate.id,
      matchKind: "order_id",
    });
  });

  it("ignores case on both sides", () => {
    const candidate = withDescription("PAID ex-20931 ONLINE");
    expect(match([candidate], { orderId: "Ex-20931", total: null }).kind).toBe(
      "matched",
    );
  });

  it("needs at least 4 characters", () => {
    const candidate = withDescription("ref A12 and AB-1");
    expect(match([candidate], { orderId: "A12", total: null })).toMatchObject({
      kind: "unmatched",
    });
    expect(match([candidate], { orderId: "AB-1", total: null }).kind).toBe(
      "matched",
    );
  });

  it("counts the trimmed length", () => {
    const candidate = withDescription("ref A12 here");
    expect(
      match([candidate], { orderId: "  A12  ", total: null }),
    ).toMatchObject({
      kind: "unmatched",
    });
  });

  it("is a substring test, not a pattern: specials are literal", () => {
    const literal = withDescription("ref AB.12*x");
    const lookalike = withDescription("ref ABx12yy");
    expect(
      match([lookalike], { orderId: "AB.12*", total: null }),
    ).toMatchObject({
      kind: "unmatched",
    });
    expect(match([literal], { orderId: "AB.12*", total: null }).kind).toBe(
      "matched",
    );
  });

  it("is ignored when the receipt has no order id", () => {
    const candidate = withDescription("EX-20931");
    expect(match([candidate], { orderId: null, total: null })).toMatchObject({
      kind: "unmatched",
    });
    expect(match([candidate], { orderId: "", total: null })).toMatchObject({
      kind: "unmatched",
    });
  });

  it("does not match a candidate whose texts are all empty", () => {
    expect(match([tx(), tx({ description: "", payeeName: "" })])).toMatchObject(
      {
        kind: "unmatched",
      },
    );
  });

  it("falls through to the amount when no candidate has the order id", () => {
    const a = amount({ payeeId: PAYEE });
    expect(match([a, withDescription("nothing")]).kind).toBe("matched");
  });
});

describe("matchReceipt: the amount signal (A)", () => {
  it("compares the absolute value in units of an expense", () => {
    expect(match([amount()])).toMatchObject({ matchKind: "amount_date" });
  });

  it("is exact: one unit off is not a match", () => {
    expect(match([tx({ amount: -37.9701 })])).toMatchObject({
      kind: "unmatched",
    });
    expect(match([tx({ amount: -37.9699 })])).toMatchObject({
      kind: "unmatched",
    });
  });

  it("is false for every candidate when no total was parsed", () => {
    const a = amount({ payeeId: PAYEE });
    expect(match([a], { orderId: null, total: null })).toMatchObject({
      kind: "unmatched",
    });
  });

  it("copes with values whose float product is off by an epsilon", () => {
    // 1.1 * 10000 is 11000.000000000002 in floats.
    const candidate = tx({ amount: -1.1 });
    expect(match([candidate], { orderId: null, total: 11000 }).kind).toBe(
      "matched",
    );
  });
});

describe("matchReceipt: the payee signal (P)", () => {
  it("needs the parser to have a payee", () => {
    const a = amount({ payeeId: null });
    const b = amount({ payeeId: null });
    // Two A candidates and two null payees: null is not the parser's payee.
    expect(match([a, b], undefined, null)).toMatchObject({
      kind: "ambiguous",
      candidateIds: [a.id, b.id],
    });
    const single = amount({ payeeId: null });
    expect(match([single], undefined, null)).toMatchObject({
      matchKind: "amount_date",
    });
  });

  it("compares payees by id, not by name", () => {
    const sameName = amount({
      payeeId: OTHER_PAYEE,
      payeeName: "Example Shop",
    });
    const sameId = amount({ payeeId: PAYEE, payeeName: "Another Name" });
    expect(match([sameName, sameId])).toMatchObject({
      transactionId: sameId.id,
      matchKind: "amount_payee",
    });
  });
});

describe("matchReceipt: the date window", () => {
  it.each([
    ["day -4", "2026-03-06", false],
    ["day -3", "2026-03-07", true],
    ["day 0", "2026-03-10", true],
    ["day +14", "2026-03-24", true],
    ["day +15", "2026-03-25", false],
  ])("%s (%s) is in the window: %s", (_label, date, inside) => {
    const candidate = amount({ transactionDate: date });
    expect(match([candidate]).kind).toBe(inside ? "matched" : "unmatched");
  });

  it("ignores an out-of-window order id match too", () => {
    const old = tx({ transactionDate: "2026-03-01", description: "EX-20931" });
    const inside = amount({ payeeId: PAYEE });
    expect(match([old, inside])).toMatchObject({
      transactionId: inside.id,
      matchKind: "amount_payee",
    });
  });

  it("counts a signal only inside the window for ambiguity as well", () => {
    const inside = amount();
    const outside = amount({ transactionDate: "2026-04-30" });
    expect(match([inside, outside])).toMatchObject({ kind: "matched" });
  });

  it("works across a month boundary", () => {
    const result = matchReceipt(
      { orderId: null, total: TOTAL },
      "2026-02-27",
      [
        amount({ transactionDate: "2026-02-24" }),
        amount({ transactionDate: "2026-03-13" }),
        amount({ transactionDate: "2026-03-14" }),
      ],
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous")
      expect(result.candidateIds).toHaveLength(2);
  });
});

describe("matchReceipt: the stored candidate list", () => {
  it("is ordered by closeness to the received date, ties by id", () => {
    const far = amount({ id: "a-far", transactionDate: "2026-03-22" });
    const before = amount({ id: "c-before", transactionDate: "2026-03-08" });
    const same2 = amount({ id: "b-same", transactionDate: RECEIVED });
    const same1 = amount({ id: "a-same", transactionDate: RECEIVED });
    const after = amount({ id: "d-after", transactionDate: "2026-03-12" });
    expect(match([far, before, same2, after, same1])).toMatchObject({
      kind: "ambiguous",
      candidateIds: ["a-same", "b-same", "c-before", "d-after", "a-far"],
    });
  });

  it("puts an earlier day before a later day at the same distance by id", () => {
    const later = amount({ id: "a-later", transactionDate: "2026-03-12" });
    const earlier = amount({ id: "b-earlier", transactionDate: "2026-03-08" });
    const result = match([earlier, later]);
    expect(result).toMatchObject({
      kind: "ambiguous",
      candidateIds: ["a-later", "b-earlier"],
    });
    // Reverse input order gives the same list.
    expect(match([later, earlier])).toEqual(result);
  });

  it("keeps at most 10, the closest ones", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      amount({
        id: `n-${String(i).padStart(2, "0")}`,
        transactionDate: i < 6 ? "2026-03-20" : RECEIVED,
      }),
    );
    const result = match(many);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidateIds).toHaveLength(MAX_STORED_CANDIDATES);
    // The six on the received date come first, then four of the six 10 days away.
    expect(result.candidateIds.slice(0, 6)).toEqual([
      "n-06",
      "n-07",
      "n-08",
      "n-09",
      "n-10",
      "n-11",
    ]);
    expect(result.candidateIds.slice(6)).toEqual([
      "n-00",
      "n-01",
      "n-02",
      "n-03",
    ]);
  });

  it("orders the O set the same way", () => {
    const near = tx({ id: "z-near", description: "EX-20931" });
    const far = tx({
      id: "a-far",
      description: "EX-20931",
      transactionDate: "2026-03-20",
    });
    expect(match([far, near])).toMatchObject({
      kind: "ambiguous",
      candidateIds: ["z-near", "a-far"],
    });
  });
});

describe("matchReceipt: paid, and the merchant the email names", () => {
  // A list price of 49.99 less a 3.00 promotion is charged 46.99.
  const LIST = 499900;
  const PAID = 469900;
  const charged = (over: Partial<ReceiptMatchCandidate> = {}) =>
    tx({ amount: -46.99, ...over });

  it("matches the amount paid, not the list price, when both are stated", () => {
    const bank = charged();
    const listPrice = tx({ amount: -49.99 });
    expect(
      match([listPrice, bank], { orderId: null, total: LIST, paid: PAID }),
    ).toMatchObject({
      kind: "matched",
      transactionId: bank.id,
      matchKind: "amount_date",
    });
  });

  it("falls back to the total when no paid was read", () => {
    const bank = tx({ amount: -49.99 });
    expect(
      match([bank], { orderId: null, total: LIST, paid: null }),
    ).toMatchObject({
      kind: "matched",
      transactionId: bank.id,
    });
  });

  it("matches nothing by amount when neither was read", () => {
    expect(
      match([charged()], { orderId: null, total: null, paid: null }),
    ).toMatchObject({
      kind: "unmatched",
    });
  });

  it("counts a candidate whose payee NAME is the merchant the email names as signal P", () => {
    const merchant = charged({
      payeeId: "payee-olx",
      payeeName: "Grupa OLX sp. z o.o.",
    });
    const other = charged();
    // The parser's payee is the gateway; the merchant is read from the email.
    expect(
      match(
        [other, merchant],
        {
          orderId: null,
          total: PAID,
          paid: PAID,
          payee: "GRUPA OLX SP. Z O.O.",
        },
        "payee-gateway",
      ),
    ).toMatchObject({
      kind: "matched",
      transactionId: merchant.id,
      matchKind: "amount_payee",
    });
  });

  it("compares the merchant ignoring case, accents and legal suffixes", () => {
    const merchant = charged({ payeeName: "Zażółć Sklep" });
    const other = charged({ payeeName: "Zazolc Inny" });
    expect(
      match(
        [other, merchant],
        { orderId: null, total: PAID, payee: "ZAZOLC SKLEP sp. z o.o." },
        null,
      ),
    ).toMatchObject({
      kind: "matched",
      transactionId: merchant.id,
      matchKind: "amount_payee",
    });
  });

  it("keeps the parser's payee id signal beside the merchant name", () => {
    const byId = charged({ payeeId: PAYEE });
    const byName = charged({ payeeId: "x", payeeName: "Shop X" });
    expect(
      match([byId, byName], { orderId: null, total: PAID, payee: "Shop X" }),
    ).toMatchObject({ kind: "ambiguous", candidateIds: [byId.id, byName.id] });
  });

  it("does not take a different merchant, or a candidate with no payee name, for the one named", () => {
    const a = charged({ payeeName: "Shop Yankee" });
    const b = charged({ payeeName: null });
    expect(
      match([a, b], { orderId: null, total: PAID, payee: "Shop Xavier" }, null),
    ).toMatchObject({ kind: "ambiguous", candidateIds: [a.id, b.id] });
  });
});

describe("matchReceipt: only an expense is a candidate", () => {
  const INCOME = 249;
  const PAID = 2490000;
  const parsed = { orderId: "EX-20931", reference: "REF-77881", total: PAID };
  const run = (
    candidates: ReceiptMatchCandidate[],
    by: ("reference" | "orderId" | "amount_payee" | "amount_date")[],
  ) =>
    matchReceipt(parsed, RECEIVED, candidates, PAYEE, {
      ...DEFAULT_MATCH_CONFIG,
      by,
    });

  it("never matches an income by amount_date", () => {
    expect(run([tx({ amount: INCOME })], ["amount_date"]).kind).toBe(
      "unmatched",
    );
  });

  it("never matches an income by amount_payee", () => {
    const income = tx({ amount: INCOME, payeeId: PAYEE });
    expect(run([income], ["amount_payee"]).kind).toBe("unmatched");
  });

  it("never matches an income whose description holds the order id", () => {
    const income = tx({ amount: INCOME, description: "order EX-20931" });
    expect(run([income], ["orderId"]).kind).toBe("unmatched");
  });

  it("never matches an income whose description holds the reference", () => {
    const income = tx({ amount: INCOME, description: "ref REF-77881" });
    expect(run([income], ["reference"]).kind).toBe("unmatched");
  });

  it("matches the expense, not ambiguous, when an income has the same amount", () => {
    const expense = tx({ amount: -INCOME });
    const income = tx({ amount: INCOME });
    expect(run([income, expense], ["amount_date"])).toMatchObject({
      kind: "matched",
      transactionId: expense.id,
    });
  });

  it("does not match a zero amount", () => {
    expect(
      matchReceipt(
        { orderId: "EX-20931", total: 0 },
        RECEIVED,
        [tx({ amount: 0 })],
        PAYEE,
      ).kind,
    ).toBe("unmatched");
  });

  it("counts only expenses in the window as considered", () => {
    const result = run(
      [tx({ amount: -INCOME }), tx({ amount: INCOME }), tx({ amount: 0 })],
      ["amount_date"],
    );
    expect(result.considered).toBe(1);
  });
});
