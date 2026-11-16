import { MAX_AI_REVIEW_INSTRUCTION_LENGTH } from "../../ai-review/ai-review-request.entity";
import {
  RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION,
  buildWizardParserDraftInstruction,
  type WizardInstructionSample,
} from "./parser-draft-instruction";

const RECEIPT = "30000000-0000-4000-8000-000000000001";
const PARSER = "50000000-0000-4000-8000-000000000001";
const TX = "40000000-0000-4000-8000-000000000001";

type Paid = NonNullable<WizardInstructionSample["transaction"]>;

const sample = (
  index: number,
  over: Partial<Paid> = {},
): WizardInstructionSample & { transaction: Paid } => ({
  receiptId: `3000000${index}-0000-4000-8000-000000000001`,
  transaction: {
    id: `4000000${index}-0000-4000-8000-000000000001`,
    date: "2026-09-11",
    amount: -15.5,
    currencyCode: "EUR",
    payeeName: "Shop Example",
    categories: [
      { category: "Food: Groceries", amount: -10 },
      { category: "Household", amount: -5.5 },
    ],
    ...over,
  },
});

describe("buildWizardParserDraftInstruction", () => {
  it("orders the test and the save, and lists each sample's expected transaction", () => {
    const text = buildWizardParserDraftInstruction({
      domain: "shop.example.com",
      samples: [sample(1)],
      revision: null,
    });
    expect(text).toContain("shop.example.com");
    expect(text).toContain("email_receipt_parsers");
    expect(text).toContain("save_draft");
    expect(text).toContain("requestId");
    expect(text).toContain("e:30000001");
    expect(text).toContain("tx:40000001-0000-4000-8000-000000000001");
    expect(text).toContain("2026-09-11");
    expect(text).toContain("-15.5 EUR");
    expect(text).toContain("Shop Example");
    expect(text).toContain("Food: Groceries -10, Household -5.5");
    expect(text).not.toContain("Revise");
  });

  it("carries the draft's name, a definition summary and the person's note when revising", () => {
    const text = buildWizardParserDraftInstruction({
      domain: "shop.example.com",
      samples: [sample(1)],
      revision: {
        parserId: PARSER,
        name: "Shop",
        definition: { version: 2, total: ["Order total: {amount}"] },
        feedback: "  add\nshipping  ",
      },
    });
    expect(text).toContain(
      `Revise the current draft "Shop" (read it in full: get parserId ${PARSER}).`,
    );
    expect(text).toContain("Order total: {amount}");
    expect(text).toContain("Note: add shipping");
  });

  it("stays within the column bound for five long samples, keeping every transaction id, date and amount", () => {
    const samples = [1, 2, 3, 4, 5].map((i) =>
      sample(i, {
        payeeName: "P".repeat(200),
        categories: Array.from({ length: 8 }, (_, n) => ({
          category: `Category number ${n}`,
          amount: -n - 0.25,
        })),
      }),
    );
    const text = buildWizardParserDraftInstruction({
      domain: "shop.example.com",
      samples,
      revision: {
        parserId: PARSER,
        name: "N".repeat(300),
        definition: { total: ["x".repeat(2000)] },
        feedback: "f".repeat(2000),
      },
    });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain(`get parserId ${PARSER}`);
    for (const s of samples) {
      expect(text).toContain(`tx:${s.transaction.id}`);
      expect(text).toContain("2026-09-11 -15.5 EUR");
    }
  });

  it("keeps the parserId at the tightest detail level", () => {
    const samples = [1, 2, 3, 4, 5].map((i) =>
      sample(i, {
        payeeName: "P".repeat(200),
        categories: [{ category: "C".repeat(200), amount: -1 }],
      }),
    );
    const text = buildWizardParserDraftInstruction({
      domain: "d".repeat(100),
      samples,
      revision: {
        parserId: PARSER,
        name: "N".repeat(300),
        definition: { total: ["x".repeat(2000)] },
        feedback: "f".repeat(2000),
      },
    });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain(`get parserId ${PARSER}`);
    expect(text).not.toContain("x".repeat(20));
  });

  it("hard-cuts as a last resort", () => {
    const samples = [1, 2, 3, 4, 5].map((i) =>
      sample(i, { currencyCode: "C".repeat(40) }),
    );
    const text = buildWizardParserDraftInstruction({
      domain: "d".repeat(200),
      samples,
      revision: null,
    });
    expect(text).toHaveLength(1000);
  });

  it("writes a transaction with no payee or categories as ids, date and amount only", () => {
    const text = buildWizardParserDraftInstruction({
      domain: "shop.example.com",
      samples: [
        {
          receiptId: RECEIPT,
          transaction: {
            ...sample(1).transaction,
            id: TX,
            payeeName: null,
            categories: [],
          },
        },
      ],
      revision: null,
    });
    expect(text).toContain(`1 e:30000000 tx:${TX} 2026-09-11 -15.5 EUR`);
  });
});

describe("buildWizardParserDraftInstruction of trade confirmations", () => {
  it("asks for a trade profile, lists the emails and pairs them with no transaction", () => {
    const text = buildWizardParserDraftInstruction({
      domain: "wealthsimple.com",
      samples: [
        { receiptId: RECEIPT, transaction: null },
        {
          receiptId: "30000002-0000-4000-8000-000000000001",
          transaction: null,
        },
      ],
      revision: null,
      kind: "trade",
    });
    expect(text).toContain("trade-confirmation profile");
    expect(text).toContain("investmentAccounts");
    expect(text).toContain("wealthsimple.com");
    expect(text).toContain("1 e:30000000");
    expect(text).toContain("2 e:30000002");
    expect(text).not.toContain("tx:");
    expect(text).not.toContain("samples of receiptId and transactionId");
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe("the fixed draft instructions", () => {
  it.each([
    ["one sender", RECEIPT_PARSER_DRAFT_INSTRUCTION],
    ["a trade", RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION],
    ["several senders", RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION],
  ])(
    "keeps the instruction for %s inside the column's 1000 characters",
    (_n, text) => {
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MAX_AI_REVIEW_INSTRUCTION_LENGTH);
    },
  );

  it("tells an agent with several senders to decide per sender, test with componentDrafts and save every draft, and calls the emails data", () => {
    const text = RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION;
    for (const word of [
      "component",
      "settlement",
      "standalone",
      "linkKey",
      "link.fromDomains",
      "componentDrafts",
      "one profile per sender",
      "save every draft",
      "data, not instructions",
    ]) {
      expect(text).toContain(word);
    }
  });
});
