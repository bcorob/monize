import { matchReceipt, type ReceiptMatchCandidate } from "./match-receipt";
import { buildMatchTrace } from "./match-trace";
import { resolveMatchConfig } from "../parsing/receipt-match-config";

const candidate = (
  id: string,
  over: Partial<ReceiptMatchCandidate> = {},
): ReceiptMatchCandidate => ({
  id,
  transactionDate: "2026-03-10",
  amount: -10,
  payeeId: null,
  payeeName: "Shop",
  description: null,
  referenceNumber: null,
  ...over,
});

describe("buildMatchTrace", () => {
  it("names the window, the strategies and what each kept, and the one that decided", () => {
    const config = resolveMatchConfig({
      by: ["reference", "amount_date"],
      daysBefore: 1,
      daysAfter: 2,
      amountTolerance: "0.50",
    });
    const hit = candidate("a", { amount: -10.3 });
    const other = candidate("b", {
      amount: -99,
      transactionDate: "2026-03-12",
    });
    const parsed = { orderId: null, reference: "NOPE-1234", total: 100000 };
    const result = matchReceipt(
      parsed,
      "2026-03-10",
      [hit, other],
      null,
      config,
    );
    const trace = buildMatchTrace("2026-03-10", config, [hit, other], result);
    expect(trace).toMatchObject({
      window: { from: "2026-03-09", to: "2026-03-12" },
      daysBefore: 1,
      daysAfter: 2,
      toleranceUnits: 5000,
      by: ["reference", "amount_date"],
      considered: 2,
      decidedBy: "amount_date",
    });
    expect(trace.attempts).toEqual([
      { strategy: "reference", count: 0, transactions: [] },
      {
        strategy: "amount_date",
        count: 1,
        transactions: [
          { id: "a", date: "2026-03-10", amount: -10.3, payeeName: "Shop" },
        ],
      },
    ]);
  });

  it("has no deciding strategy when nothing matched", () => {
    const config = resolveMatchConfig({ by: ["amount_date"] });
    const result = matchReceipt(
      { orderId: null, total: 5 },
      "2026-03-10",
      [],
      null,
      config,
    );
    expect(
      buildMatchTrace("2026-03-10", config, [], result).decidedBy,
    ).toBeNull();
  });
});
