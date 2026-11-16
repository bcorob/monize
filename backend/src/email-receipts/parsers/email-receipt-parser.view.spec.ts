import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { WEALTHSIMPLE_TRADE_DEFINITION } from "../parsing/fixtures/wealthsimple-trade";
import { validateReceiptParserDefinition } from "../parsing/receipt-parser.validation";
import { toParserView } from "./email-receipt-parser.view";

const row = (definition: Record<string, unknown>): EmailReceiptParser =>
  Object.assign(new EmailReceiptParser(), {
    id: "p-1",
    name: "Profile",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition,
    status: "approved",
    source: "manual",
    approvedAt: null,
    revision: 1,
    createdAt: new Date("2026-10-16T00:00:00Z"),
    updatedAt: new Date("2026-10-16T00:00:00Z"),
  });

describe("toParserView", () => {
  it("shows a receipt profile with the matching it effectively has", () => {
    const view = toParserView(row({ version: 2, total: ["Total: {amount}"] }));
    expect(view.definitionValid).toBe(true);
    expect(view.definition.match).toMatchObject({ by: expect.any(Array) });
  });

  // A trade profile carried the receipt matching defaults, so the editor
  // opened it as JSON, and saving that JSON back was refused (`match` beside
  // `trade` is trade_conflict).
  it("shows a trade profile as stored, with no matching, so it saves back unchanged", () => {
    const stored = JSON.parse(
      JSON.stringify(WEALTHSIMPLE_TRADE_DEFINITION),
    ) as Record<string, unknown>;
    const view = toParserView(row(stored));

    expect(view.definitionValid).toBe(true);
    expect(view.definition).toEqual(WEALTHSIMPLE_TRADE_DEFINITION);
    expect(view.definition).not.toHaveProperty("match");
    expect(validateReceiptParserDefinition(view.definition).ok).toBe(true);
  });
});
