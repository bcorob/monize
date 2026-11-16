import {
  type ReceiptMatchCandidate,
  matchReceipt,
  receiptCandidateWindow,
} from "./match-receipt";
import {
  resolveMatchConfig,
  type ResolvedMatchConfig,
} from "../parsing/receipt-match-config";

/**
 * The matching a profile configures (design 5.5, spec 3a): the strategies in the
 * profile's order, the fields a reference is looked for in, the amount tolerance
 * and the date window. The default truth table is `match-receipt.spec.ts`.
 */

const PURCHASE = "2026-03-10";
const PAYEE = "payee-shop";
const TOTAL = 379700; // 37.97

let counter = 0;
const tx = (
  over: Partial<ReceiptMatchCandidate> = {},
): ReceiptMatchCandidate => {
  counter += 1;
  return {
    id: `tx-${String(counter).padStart(3, "0")}`,
    transactionDate: PURCHASE,
    amount: -99.99,
    payeeId: "payee-other",
    payeeName: "Corner Store",
    description: null,
    referenceNumber: null,
    ...over,
  };
};
const priced = (over: Partial<ReceiptMatchCandidate> = {}) =>
  tx({ amount: -37.97, ...over });

const config = (
  match: Parameters<typeof resolveMatchConfig>[0],
): ResolvedMatchConfig => resolveMatchConfig(match);

const run = (
  candidates: ReceiptMatchCandidate[],
  match: Parameters<typeof resolveMatchConfig>[0],
  parsed: {
    orderId?: string | null;
    reference?: string | null;
    total?: number | null;
    payee?: string | null;
  } = {},
  payeeId: string | null = PAYEE,
) =>
  matchReceipt(
    {
      orderId: parsed.orderId ?? null,
      reference: parsed.reference ?? null,
      total: parsed.total === undefined ? TOTAL : parsed.total,
      payee: parsed.payee ?? null,
    },
    PURCHASE,
    candidates,
    payeeId,
    config(match),
  );

describe("matchReceipt with a profile: strategies in the profile's order", () => {
  it("matches by reference and stores the kind `reference`", () => {
    const hit = tx({ description: "CARD PAYU 4455667788 SHOP" });
    const result = run(
      [tx(), hit],
      { by: ["reference"] },
      {
        reference: "4455667788",
      },
    );
    expect(result).toMatchObject({
      kind: "matched",
      transactionId: hit.id,
      matchKind: "reference",
      strategy: "reference",
    });
  });

  it("tries the strategies in order and passes to the next when one finds nothing", () => {
    const byAmount = priced();
    const result = run(
      [tx(), byAmount],
      { by: ["reference", "orderId", "amount_date"] },
      { reference: "REF-12345", orderId: "ORD-98765" },
    );
    expect(result).toMatchObject({
      kind: "matched",
      transactionId: byAmount.id,
      matchKind: "amount_date",
    });
    expect(result.attempts.map((a) => [a.strategy, a.count])).toEqual([
      ["reference", 0],
      ["orderId", 0],
      ["amount_date", 1],
    ]);
  });

  it("lets an earlier strategy win over a later one that would also match", () => {
    const byOrder = tx({ description: "ORD-98765" });
    const byRef = tx({ description: "REF-12345" });
    const first = run(
      [byOrder, byRef],
      { by: ["reference", "orderId"] },
      { reference: "REF-12345", orderId: "ORD-98765" },
    );
    expect(first).toMatchObject({
      transactionId: byRef.id,
      matchKind: "reference",
    });
    const second = run(
      [byOrder, byRef],
      { by: ["orderId", "reference"] },
      { reference: "REF-12345", orderId: "ORD-98765" },
    );
    expect(second).toMatchObject({
      transactionId: byOrder.id,
      matchKind: "order_id",
    });
  });

  it("is ambiguous with exactly the candidates of the strategy that found several, without trying the next", () => {
    const a = tx({ description: "REF-12345 A" });
    const b = tx({ description: "REF-12345 B" });
    const exact = priced();
    const result = run(
      [a, b, exact],
      { by: ["reference", "amount_date"] },
      { reference: "REF-12345" },
    );
    expect(result).toMatchObject({
      kind: "ambiguous",
      strategy: "reference",
      candidateIds: [a.id, b.id],
    });
    expect(result.attempts).toHaveLength(1);
  });

  it("is unmatched when every strategy found nothing, and says what each looked at", () => {
    const result = run(
      [tx(), tx()],
      { by: ["reference", "amount_payee"] },
      {
        reference: "REF-12345",
      },
    );
    expect(result.kind).toBe("unmatched");
    expect(result.considered).toBe(2);
    expect(result.attempts.map((a) => a.strategy)).toEqual([
      "reference",
      "amount_payee",
    ]);
  });

  it("with `amount_date` alone ignores the payee signal", () => {
    const a = priced({ payeeId: PAYEE });
    const b = priced();
    expect(run([a, b], { by: ["amount_date"] })).toMatchObject({
      kind: "ambiguous",
      strategy: "amount_date",
    });
    expect(run([a, b], { by: ["amount_payee"] })).toMatchObject({
      kind: "matched",
      transactionId: a.id,
      matchKind: "amount_payee",
    });
  });

  it("never reads a reference of fewer than four characters", () => {
    const hit = tx({ description: "ref A12" });
    expect(
      run([hit], { by: ["reference"] }, { reference: "A12" }),
    ).toMatchObject({
      kind: "unmatched",
    });
    expect(
      run([hit], { by: ["reference"] }, { reference: null }),
    ).toMatchObject({
      kind: "unmatched",
    });
  });
});

describe("matchReceipt with a profile: referenceIn", () => {
  const description = tx({ description: "REF-12345" });
  const payeeName = tx({ payeeName: "SHOP REF-12345" });
  const referenceNumber = tx({ referenceNumber: "ref-12345" });
  const all = [description, payeeName, referenceNumber];

  it("looks in every field by default, case-insensitively", () => {
    const result = run(all, { by: ["reference"] }, { reference: "Ref-12345" });
    expect(result).toMatchObject({ kind: "ambiguous" });
    expect(result.attempts[0].count).toBe(3);
  });

  it.each([
    [["description"], description.id],
    [["payee"], payeeName.id],
    [["referenceNumber"], referenceNumber.id],
  ] as const)("looks only in %j", (fields, expected) => {
    const result = run(
      all,
      { by: ["reference"], referenceIn: [...fields] },
      { reference: "REF-12345" },
    );
    expect(result).toMatchObject({ kind: "matched", transactionId: expected });
  });

  it("applies to the order id strategy too", () => {
    const result = run(
      all,
      { by: ["orderId"], referenceIn: ["payee"] },
      { orderId: "REF-12345" },
    );
    expect(result).toMatchObject({
      kind: "matched",
      transactionId: payeeName.id,
      matchKind: "order_id",
    });
  });
});

describe("matchReceipt with a profile: amountTolerance", () => {
  // amounts are compared in 1/10000 units: 37.97 is 379700.
  const at = (amount: number) => tx({ amount });

  it("is exact by default", () => {
    expect(run([at(-37.98)], { by: ["amount_date"] }).kind).toBe("unmatched");
    expect(run([at(-37.97)], { by: ["amount_date"] }).kind).toBe("matched");
  });

  it("matches a difference up to the tolerance, inclusive, either way", () => {
    const m = { by: ["amount_date" as const], amountTolerance: "0.50" };
    expect(run([at(-38.47)], m).kind).toBe("matched");
    expect(run([at(-37.47)], m).kind).toBe("matched");
    expect(run([at(-38.48)], m).kind).toBe("unmatched");
    expect(run([at(-37.46)], m).kind).toBe("unmatched");
  });

  it("is compared in integer units: no float drift at the edge", () => {
    // 0.10 and 0.20 do not add exactly in binary floating point.
    const m = { by: ["amount_date" as const], amountTolerance: "0.30" };
    expect(run([at(-38.27)], m).kind).toBe("matched");
    expect(run([at(-38.28)], m).kind).toBe("unmatched");
  });

  it("applies to amount_payee as well, together with the payee signal", () => {
    const m = { by: ["amount_payee" as const], amountTolerance: "1.00" };
    const near = tx({ amount: -38.5, payeeId: PAYEE });
    const nearOther = tx({ amount: -38.5 });
    expect(run([nearOther], m).kind).toBe("unmatched");
    expect(run([near, nearOther], m)).toMatchObject({
      kind: "matched",
      transactionId: near.id,
    });
  });

  it("finds several candidates inside the tolerance ambiguous", () => {
    const m = { by: ["amount_date" as const], amountTolerance: "5.00" };
    expect(run([at(-35), at(-40)], m).kind).toBe("ambiguous");
  });

  it("matches nothing by amount when the email states none, whatever the tolerance", () => {
    expect(
      run(
        [at(-37.97)],
        { by: ["amount_date"], amountTolerance: "5.00" },
        { total: null },
      ).kind,
    ).toBe("unmatched");
  });
});

describe("matchReceipt with a profile: the window", () => {
  const dated = (transactionDate: string) => priced({ transactionDate });

  it("is 3 days before and 14 after by default", () => {
    expect(receiptCandidateWindow(PURCHASE)).toEqual({
      from: "2026-03-07",
      to: "2026-03-24",
    });
  });

  it("follows daysBefore and daysAfter, inclusive", () => {
    const m = { by: ["amount_date" as const], daysBefore: 0, daysAfter: 30 };
    expect(receiptCandidateWindow(PURCHASE, config(m))).toEqual({
      from: "2026-03-10",
      to: "2026-04-09",
    });
    expect(run([dated("2026-03-09")], m).kind).toBe("unmatched");
    expect(run([dated("2026-03-10")], m).kind).toBe("matched");
    expect(run([dated("2026-04-09")], m).kind).toBe("matched");
    expect(run([dated("2026-04-10")], m).kind).toBe("unmatched");
  });

  it("reaches the bounds a profile may set: 60 days before and 90 after", () => {
    const m = { by: ["amount_date" as const], daysBefore: 60, daysAfter: 90 };
    expect(receiptCandidateWindow(PURCHASE, config(m))).toEqual({
      from: "2026-01-09",
      to: "2026-06-08",
    });
    expect(run([dated("2026-01-09")], m).kind).toBe("matched");
    expect(run([dated("2026-01-08")], m).kind).toBe("unmatched");
  });

  it("counts only the candidates inside the window as considered", () => {
    const result = run([dated("2026-03-10"), dated("2026-03-30")], {
      by: ["amount_date"],
    });
    expect(result.considered).toBe(1);
  });
});
