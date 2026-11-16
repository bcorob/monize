import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import type { AiActionsService } from "../../ai/actions/ai-actions.service";
import { AiReviewRequest } from "../../ai-review/ai-review-request.entity";
import type { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import type { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import type { AiReviewSubmitResult } from "../../ai-review/ai-review-work.types";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import type { PayeesService } from "../../payees/payees.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { EmailReceiptCategoryAiService } from "../ai/email-receipt-category-ai.service";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import {
  applyCategoryHints,
  EmailReceiptPipelineService,
  type ProcessReceiptOptions,
} from "./email-receipt-pipeline.service";
import {
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CATEGORIZE_INSTRUCTION,
} from "./receipt-instructions";

/**
 * What a profile configures beyond reading the email (design 5.5 and 5.6): the
 * `match` section and the `reference` field, the `tag`, and the AI's categories
 * for the items no rule matched. The rest of the pipeline is
 * `email-receipt-pipeline.service.spec.ts`.
 */

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const RECEIPT = "receipt-1";
const TX = "tx-1";
const CAT_BOOKS = "11111111-1111-4111-8111-111111111111";
const CAT_SHIPPING = "22222222-2222-4222-8222-222222222222";
const CAT_TOYS = "33333333-3333-4333-8333-333333333333";

const BASE = {
  version: 2,
  orderId: ["Order number: {orderid}"],
  total: ["Order total: {amount}"],
  shipping: ["Shipping: {amount}"],
  items: {
    startAfter: "Items",
    stopAt: "Subtotal",
    patterns: ["{name} {amount}"],
  },
  defaultCategoryId: CAT_BOOKS,
  shippingCategoryId: CAT_SHIPPING,
};
/** Rules categorise nothing: every item is bare, shipping is categorised. */
const UNCATEGORIZED = {
  ...BASE,
  defaultCategoryId: undefined,
  aiCategories: true,
};

const BODY = [
  "Order number: ABCD1234",
  "Statement text: PAYU*998877",
  "Items",
  "Widget 12.00",
  "Subtotal 12.00",
  "Shipping: 3.00",
  "Order total: 15.00",
].join("\n");
const TWO_ITEMS = [
  "Order number: ABCD1234",
  "Items",
  "Widget 8.00",
  "Gadget 4.00",
  "Subtotal 12.00",
  "Shipping: 3.00",
  "Order total: 15.00",
].join("\n");

const receiptRow = (over: Partial<EmailReceipt> = {}): EmailReceipt =>
  Object.assign(new EmailReceipt(), {
    id: RECEIPT,
    userId: USER,
    mailboxId: "mb-1",
    fromAddress: "orders@shop.example.com",
    fromDomain: "shop.example.com",
    subject: "Your order ABCD1234",
    receivedAt: new Date("2026-09-10T10:00:00Z"),
    bodyText: BODY,
    bodyHtml: null,
    status: "pending",
    statusReason: null,
    parserId: null,
    parsed: null,
    transactionId: null,
    candidateTransactionIds: [],
    matchKind: null,
    aiReviewRequestId: null,
    ...over,
  });

const parserRow = (definition: Record<string, unknown>) =>
  Object.assign(new EmailReceiptParser(), {
    id: "parser-1",
    userId: USER,
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition,
    status: "approved",
    source: "manual",
    revision: 1,
    createdAt: new Date("2026-09-01T00:00:00Z"),
  });

const candidate = (over: Record<string, unknown> = {}) => ({
  id: TX,
  transaction_date: "2026-09-11",
  amount: "-15.0000",
  payee_id: null,
  payee_name: null,
  description: "CARD PURCHASE ORDER ABCD1234",
  reference_number: null,
  ...over,
});

const action: PendingAiAction = {
  actionId: "action-1",
  type: "update_transaction",
  preview: {} as PendingAiAction["preview"],
  descriptor: { type: "update_transaction" } as PendingAiAction["descriptor"],
  signature: "sig-1",
  expiresAt: 1_900_000_000_000,
};
const submitted = (): AiReviewSubmitResult => ({
  request: {} as AiReviewSubmitResult["request"],
  action,
});

interface World {
  /** What `PayeesService.resolveByName` answers for a schema.org order's seller. */
  sellerPayee: Partial<Payee> | null;
  receipt: EmailReceipt;
  aiMode: "off" | "on_demand" | "automatic";
  definition: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    sellerPayee: null,
    receipt: receiptRow(),
    aiMode: "off",
    definition: BASE,
    candidates: [candidate()],
    ...over,
  };
  const receiptRepo = {
    findOne: jest.fn(async () => world.receipt),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mailboxRepo = {
    findOne: jest.fn(async () =>
      Object.assign(new EmailReceiptMailbox(), {
        id: "mb-1",
        userId: USER,
        aiMode: world.aiMode,
        autoApply: false,
      }),
    ),
  };
  const parserRepo = {
    find: jest.fn(async () => [parserRow(world.definition)]),
  };
  const categoryRepo = {
    find: jest.fn(async () => [
      { id: CAT_BOOKS, name: "Books", parentId: null },
      { id: CAT_SHIPPING, name: "Shipping", parentId: null },
      { id: CAT_TOYS, name: "Toys", parentId: null },
    ]),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
    [EmailReceiptMailbox, mailboxRepo],
    [EmailReceiptParser, parserRepo],
    [Payee, { findOne: jest.fn(async () => null) }],
    [Category, categoryRepo],
  ]);
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("SET status = 'rejected'")) return [[], 0];
    if (/SELECT status(, kind)? FROM ai_review_requests/.test(text)) return [];
    if (text.includes("JOIN accounts a")) return world.candidates;
    return [];
  });
  const requests = {
    enqueueClaimed: jest.fn(async () =>
      Object.assign(new AiReviewRequest(), { id: "rq-1" }),
    ),
    enqueuePendingForReceipt: jest.fn(async () =>
      Object.assign(new AiReviewRequest(), { id: "rq-pending" }),
    ),
    release: jest.fn(async () => null),
  } as unknown as jest.Mocked<AiReviewRequestsService>;
  const work = {
    submit: jest.fn(async () => submitted()),
  } as unknown as jest.Mocked<AiReviewWorkService>;
  const actions = {
    confirm: jest.fn(),
  } as unknown as jest.Mocked<AiActionsService>;
  const categoryAi = {
    canAnswerNow: jest.fn(async () => true),
    categorize: jest.fn(
      async (): Promise<Map<number, string> | null> => new Map(),
    ),
  } as unknown as jest.Mocked<EmailReceiptCategoryAiService>;
  const service = new EmailReceiptPipelineService(
    dataSource as never,
    requests,
    work,
    actions,
    {
      resolveByName: jest.fn(async () => world.sellerPayee),
    } as unknown as PayeesService,
    categoryAi,
    { process: jest.fn() } as never,
  );
  return {
    service,
    world,
    manager,
    receiptRepo,
    requests,
    work,
    actions,
    categoryAi,
    stored: () =>
      receiptRepo.update.mock.calls[
        receiptRepo.update.mock.calls.length - 1
      ][1] as Record<string, unknown>,
    candidateQueries: () =>
      manager.query.mock.calls.filter((c) =>
        String(c[0]).includes("JOIN accounts a"),
      ),
  };
}

const run = (
  h: ReturnType<typeof setup>,
  options: ProcessReceiptOptions = {},
) => h.service.process(USER, RECEIPT, options);

const submittedInput = (h: ReturnType<typeof setup>) =>
  h.work.submit.mock.calls[0][3];

describe("a profile's match section", () => {
  it("loads candidates for the profile's window, centred on the purchase date", async () => {
    const h = setup({
      definition: { ...BASE, match: { daysBefore: 0, daysAfter: 30 } },
    });
    await run(h);
    const [[, params]] = h.candidateQueries() as unknown as [
      [string, string[]],
    ];
    expect(params[1]).toBe("2026-09-10");
    expect(params[2]).toBe("2026-10-10");
  });

  it("uses the 3 and 14 day window when the profile says nothing", async () => {
    const h = setup();
    await run(h);
    const [[, params]] = h.candidateQueries() as unknown as [
      [string, string[]],
    ];
    expect(params[1]).toBe("2026-09-07");
    expect(params[2]).toBe("2026-09-24");
  });

  it("matches by amount within the profile's tolerance and stores amount_date", async () => {
    const h = setup({
      definition: {
        ...BASE,
        match: { by: ["amount_date"], amountTolerance: "0.50" },
      },
      candidates: [candidate({ amount: "-15.4000", description: "CARD" })],
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "review",
      matchKind: "amount_date",
      transactionId: TX,
    });
    expect(h.stored()).toMatchObject({ matchKind: "amount_date" });
  });

  it("does not match the same bank amount without the tolerance", async () => {
    const h = setup({
      definition: { ...BASE, match: { by: ["amount_date"] } },
      candidates: [candidate({ amount: "-15.4000", description: "CARD" })],
    });
    const result = await run(h);
    expect(result.status).toBe("unmatched");
  });

  it("follows the strategies in the profile's order", async () => {
    const h = setup({
      definition: { ...BASE, match: { by: ["amount_date", "orderId"] } },
      candidates: [
        candidate({ id: "by-amount", description: "CARD" }),
        candidate({ id: "by-order", amount: "-99.0000" }),
      ],
    });
    const result = await run(h);
    expect(result).toMatchObject({
      transactionId: "by-amount",
      matchKind: "amount_date",
    });
  });

  it("stores the strategies' ambiguity as candidates", async () => {
    const h = setup({
      definition: { ...BASE, match: { by: ["amount_date"] } },
      candidates: [
        candidate({ id: "a", description: "CARD" }),
        candidate({ id: "b", description: "OTHER" }),
      ],
    });
    const result = await run(h);
    expect(result.status).toBe("ambiguous");
    expect(h.stored()).toMatchObject({ candidateTransactionIds: ["a", "b"] });
  });
});

describe("a profile's reference field", () => {
  const withReference = {
    ...BASE,
    reference: ["Statement text: {reference}"],
    match: { by: ["reference", "amount_date"], referenceIn: ["description"] },
  };

  it("reads the reference, matches the transaction that carries it and stores the kind `reference`", async () => {
    const h = setup({
      definition: withReference,
      candidates: [
        candidate({ id: "other", description: "NOTHING" }),
        candidate({ id: "hit", description: "CARD PAYU*998877 SHOP" }),
      ],
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "review",
      transactionId: "hit",
      matchKind: "reference",
    });
    expect(h.stored()).toMatchObject({
      parsed: expect.objectContaining({ reference: "PAYU*998877" }),
    });
  });

  it("goes on matching on a reference alone, with no total and no order id", async () => {
    const h = setup({
      definition: {
        version: 2,
        reference: ["Statement text: {reference}"],
        match: { by: ["reference"] },
      },
      receipt: receiptRow({ bodyText: "Statement text: PAYU*998877" }),
      candidates: [candidate({ description: "CARD PAYU*998877" })],
    });
    const result = await run(h);
    expect(result).toMatchObject({ status: "review", matchKind: "reference" });
  });

  it("is parse_failed when the email yields no total, no order id and no reference", async () => {
    const h = setup({
      definition: withReference,
      receipt: receiptRow({ bodyText: "nothing" }),
    });
    expect((await run(h)).status).toBe("parse_failed");
  });
});

describe("a profile's tag", () => {
  it("adds the tag to a proposal that categorises the transaction", async () => {
    const h = setup({ definition: { ...BASE, tag: "Allegro" } });
    await run(h);
    expect(submittedInput(h)).toMatchObject({
      splits: expect.any(Array),
      tagNames: ["Allegro"],
    });
  });

  it("adds none when the profile has no tag", async () => {
    const h = setup();
    await run(h);
    expect(submittedInput(h)).not.toHaveProperty("tagNames");
  });

  it("adds none to a description-only proposal: the profile did not split it", async () => {
    const h = setup({
      definition: { ...BASE, tag: "Allegro" },
      receipt: receiptRow({
        bodyText: BODY.replace("Order total: 15.00", "Order total: 99.00"),
      }),
      candidates: [candidate({ amount: "-99.0000" })],
    });
    await run(h);
    expect(submittedInput(h)).toBeDefined();
    expect(submittedInput(h)).not.toHaveProperty("tagNames");
    expect(submittedInput(h)).not.toHaveProperty("splits");
  });

  it("adds none to a reading a parser fell back to the email's own schema.org markup for", async () => {
    const markup =
      '<html><script type="application/ld+json">' +
      JSON.stringify({
        "@context": "http://schema.org",
        "@type": "Order",
        merchant: { "@type": "Organization", name: "Example Shop" },
        orderNumber: "ABCD1234",
        price: "15.00",
        acceptedOffer: [
          {
            "@type": "Offer",
            itemOffered: { "@type": "Product", name: "Widget" },
            price: "12.00",
          },
          {
            "@type": "Offer",
            itemOffered: { "@type": "Product", name: "Gadget" },
            price: "3.00",
          },
        ],
      }) +
      "</script></html>";
    const h = setup({
      definition: { ...BASE, tag: "Allegro" },
      receipt: receiptRow({
        bodyText: "nothing the parser can read\nOrder number: ABCD1234",
        bodyHtml: markup,
      }),
      sellerPayee: {
        id: "s1",
        name: "Example Shop",
        defaultCategoryId: CAT_BOOKS,
      },
    });
    const result = await run(h);
    // The markup was read and categorised (by the seller's payee), and proposed...
    expect(result).toMatchObject({ status: "review" });
    expect(submittedInput(h)).toHaveProperty("splits");
    // ...but it is not what the profile split, so the profile's tag is not added.
    expect(submittedInput(h)).not.toHaveProperty("tagNames");
  });
});

describe("the AI's categories for the items no rule matched (design 5.6)", () => {
  const answering = (over: Partial<World> = {}) =>
    setup({
      definition: UNCATEGORIZED,
      aiMode: "on_demand",
      receipt: receiptRow({ bodyText: TWO_ITEMS }),
      ...over,
    });

  it("asks the AI once for the bare items, outside any transaction, and proposes with the categories it chose", async () => {
    const h = answering();
    h.categoryAi.categorize.mockResolvedValue(
      new Map([
        [0, CAT_TOYS],
        [1, CAT_BOOKS],
      ]),
    );

    const result = await run(h);

    expect(h.categoryAi.canAnswerNow).toHaveBeenCalledWith(USER);
    expect(h.categoryAi.categorize).toHaveBeenCalledTimes(1);
    const [userId, items, categories] = h.categoryAi.categorize.mock.calls[0];
    expect(userId).toBe(USER);
    expect(items).toEqual([
      { index: 0, name: "Widget", qty: 1, amount: 80000 },
      { index: 1, name: "Gadget", qty: 1, amount: 40000 },
    ]);
    expect(categories.get(CAT_TOYS)).toBe("Toys");
    expect(result).toMatchObject({ status: "review", requestId: "rq-1" });
    expect(submittedInput(h).splits).toEqual([
      {
        categoryName: "Toys",
        amount: -8,
        memo: "Widget",
        categorySource: "ai",
      },
      {
        categoryName: "Books",
        amount: -4,
        memo: "Gadget",
        categorySource: "ai",
      },
      { categoryName: "Shipping", amount: -3 },
    ]);
    // One write for the receipt: the pass that asked wrote nothing.
    expect(h.receiptRepo.update).toHaveBeenCalledTimes(1);
    expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
  });

  it("marks each item the AI categorised with categorySource ai, and only those", async () => {
    const h = answering();
    h.categoryAi.categorize.mockResolvedValue(new Map([[0, CAT_TOYS]]));
    await run(h);
    const parsed = h.stored().parsed as ParsedReceipt;
    expect(parsed.items[0]).toMatchObject({
      categoryId: CAT_TOYS,
      categorySource: "ai",
    });
    expect(parsed.items[1].categoryId).toBeNull();
    expect(parsed.items[1]).not.toHaveProperty("categorySource");
    // One item stayed bare: the proposal is description-only, as today, and the
    // AI is not asked again nor a request queued.
    expect(parsed.complete).toBe(false);
    expect(submittedInput(h)).not.toHaveProperty("splits");
    expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
  });

  it("only asks for the items a rule left bare", async () => {
    const h = answering({
      definition: {
        ...UNCATEGORIZED,
        categoryRules: [{ match: "Widget", categoryId: CAT_TOYS }],
      },
    });
    h.categoryAi.categorize.mockResolvedValue(new Map([[1, CAT_BOOKS]]));
    await run(h);
    const items = h.categoryAi.categorize.mock.calls[0][1];
    expect(items.map((i) => [i.index, i.name])).toEqual([[1, "Gadget"]]);
    const parsed = h.stored().parsed as ParsedReceipt;
    expect(parsed.items[0]).not.toHaveProperty("categorySource");
    expect(parsed.items[1]).toMatchObject({ categorySource: "ai" });
    expect(parsed.complete).toBe(true);
  });

  it("never asks when the profile does not turn it on", async () => {
    const h = answering({
      definition: { ...UNCATEGORIZED, aiCategories: false },
    });
    const result = await run(h);
    expect(h.categoryAi.canAnswerNow).not.toHaveBeenCalled();
    expect(h.categoryAi.categorize).not.toHaveBeenCalled();
    expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
    // Today's behaviour: a description-only proposal that names the reason.
    expect(result.status).toBe("review");
    expect(h.stored()).toMatchObject({ statusReason: "items_uncategorized" });
    expect(submittedInput(h)).not.toHaveProperty("splits");
  });

  it("never asks when the profile omits the key", async () => {
    const { aiCategories: _omit, ...without } = UNCATEGORIZED;
    const h = answering({ definition: without });
    await run(h);
    expect(h.categoryAi.categorize).not.toHaveBeenCalled();
    expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
  });

  it("never asks when every item already has a category", async () => {
    const h = answering({ definition: { ...BASE, aiCategories: true } });
    await run(h);
    expect(h.categoryAi.canAnswerNow).not.toHaveBeenCalled();
    expect(h.categoryAi.categorize).not.toHaveBeenCalled();
  });

  it("never asks before a transaction matched", async () => {
    const h = answering({ candidates: [] });
    const result = await run(h);
    expect(result.status).toBe("unmatched");
    expect(h.categoryAi.canAnswerNow).not.toHaveBeenCalled();
    expect(h.categoryAi.categorize).not.toHaveBeenCalled();
    expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
  });

  describe("when the in-app AI cannot answer: the items stay uncategorized and the request waits for an agent", () => {
    const expectQueued = (h: ReturnType<typeof setup>) => {
      expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalledWith(
        h.manager,
        USER,
        {
          transactionId: TX,
          emailReceiptId: RECEIPT,
          instruction: RECEIPT_CATEGORIZE_INSTRUCTION,
        },
      );
      // No profile proposal beside it: one open request per transaction.
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.stored()).toMatchObject({
        status: "review",
        aiReviewRequestId: "rq-pending",
        statusReason: "items_uncategorized",
        transactionId: TX,
      });
      const parsed = h.stored().parsed as ParsedReceipt;
      expect(parsed.items.every((item) => item.categoryId === null)).toBe(true);
    };

    it("the mailbox's AI mode is off: no provider is called", async () => {
      const h = answering({ aiMode: "off" });
      const result = await run(h);
      expect(h.categoryAi.canAnswerNow).not.toHaveBeenCalled();
      expect(h.categoryAi.categorize).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "review",
        requestId: "rq-pending",
      });
      expectQueued(h);
    });

    it("no provider answers now", async () => {
      const h = answering();
      h.categoryAi.canAnswerNow.mockResolvedValue(false);
      await run(h);
      expect(h.categoryAi.categorize).not.toHaveBeenCalled();
      expectQueued(h);
    });

    it("the question could not be asked: a failed read of the status is a no", async () => {
      const h = answering();
      h.categoryAi.canAnswerNow.mockRejectedValue(new Error("down"));
      await run(h);
      expect(h.categoryAi.categorize).not.toHaveBeenCalled();
      expectQueued(h);
    });

    it("the AI did not give a usable answer", async () => {
      const h = answering();
      h.categoryAi.categorize.mockResolvedValue(null);
      await run(h);
      expect(h.categoryAi.categorize).toHaveBeenCalledTimes(1);
      expectQueued(h);
    });

    it("the batch's budget of questions is spent", async () => {
      const h = answering();
      const budget = { remaining: 0 };
      await run(h, { aiCategoryBudget: budget });
      expect(h.categoryAi.canAnswerNow).not.toHaveBeenCalled();
      expect(h.categoryAi.categorize).not.toHaveBeenCalled();
      expectQueued(h);
    });

    it("queues a review conflict when the transaction already has an open request", async () => {
      const h = answering({ aiMode: "off" });
      h.requests.enqueuePendingForReceipt.mockResolvedValue(null);
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review_conflict",
        requestId: null,
      });
    });

    it("the poll's automatic step never takes this request: its instruction is not the poll's", () => {
      expect(RECEIPT_CATEGORIZE_INSTRUCTION).not.toBe(
        RECEIPT_AUTOMATIC_AI_INSTRUCTION,
      );
      expect(RECEIPT_CATEGORIZE_INSTRUCTION.length).toBeLessThanOrEqual(1000);
      expect(RECEIPT_CATEGORIZE_INSTRUCTION).toMatch(
        /^Assign a category to each uncategorized item/,
      );
    });
  });

  it("spends one question of the budget per receipt it asks about", async () => {
    const h = answering();
    const budget = { remaining: 3 };
    await run(h, { aiCategoryBudget: budget });
    expect(budget.remaining).toBe(2);
  });

  it("serves a person's link the same way", async () => {
    const h = answering({ aiMode: "off" });
    (h.manager.query as jest.Mock).mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("SET status = 'rejected'")) return [[], 0];
      if (text.includes("WHERE t.id = $1")) {
        return [
          {
            id: "tx-9",
            amount: "-15.0000",
            description: "CARD",
            payee_id: null,
            is_transfer: false,
            status: "UNRECONCILED",
            plain: true,
          },
        ];
      }
      return [];
    });
    const result = await run(h, { link: { transactionId: "tx-9" } });
    expect(result).toMatchObject({ matchKind: "manual", status: "review" });
    expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalledWith(
      h.manager,
      USER,
      expect.objectContaining({
        transactionId: "tx-9",
        instruction: RECEIPT_CATEGORIZE_INSTRUCTION,
      }),
    );
  });

  it("does not ask the AI itself again when a caller already decided (hints given)", async () => {
    const h = answering();
    const result = await run(h, {
      categoryHints: [
        { index: 0, name: "Widget", categoryId: CAT_TOYS },
        { index: 1, name: "Gadget", categoryId: CAT_BOOKS },
      ],
    });
    expect(h.categoryAi.categorize).not.toHaveBeenCalled();
    expect(result.status).toBe("review");
    expect(submittedInput(h).splits).toHaveLength(3);
  });
});

describe("applyCategoryHints", () => {
  const categories = new Map([
    [CAT_BOOKS, "Books"],
    [CAT_TOYS, "Toys"],
  ]);
  const item = (name: string, amount: number, categoryId: string | null) => ({
    name,
    qty: 1,
    amount,
    categoryId,
  });
  const reading = (items: ParsedReceipt["items"]): ParsedReceipt => ({
    orderId: null,
    total: items.reduce((sum, i) => sum + i.amount, 0),
    paid: null,
    payee: null,
    shipping: null,
    discount: null,
    items,
    shippingCategoryId: null,
    discountCategoryId: null,
    complete: false,
    reason: "items_uncategorized",
  });

  it("fills a bare item, marks it ai, and judges completeness again", () => {
    const next = applyCategoryHints(
      reading([item("Widget", 100000, null)]),
      [{ index: 0, name: "Widget", categoryId: CAT_TOYS }],
      categories,
    );
    expect(next.items[0]).toEqual({
      name: "Widget",
      qty: 1,
      amount: 100000,
      categoryId: CAT_TOYS,
      categorySource: "ai",
    });
    expect(next.complete).toBe(true);
    expect(next.reason).toBeNull();
  });

  it("leaves a categorised item alone, even when a hint names it", () => {
    const next = applyCategoryHints(
      reading([item("Widget", 100000, CAT_BOOKS)]),
      [{ index: 0, name: "Widget", categoryId: CAT_TOYS }],
      categories,
    );
    expect(next.items[0].categoryId).toBe(CAT_BOOKS);
    expect(next.items[0]).not.toHaveProperty("categorySource");
  });

  it("ignores a hint whose name is not the item's (the reading changed since)", () => {
    const next = applyCategoryHints(
      reading([item("Widget", 100000, null)]),
      [{ index: 0, name: "Gadget", categoryId: CAT_TOYS }],
      categories,
    );
    expect(next.items[0].categoryId).toBeNull();
    expect(next.reason).toBe("items_uncategorized");
  });

  it("ignores a category the user does not own and an index that is not an item", () => {
    const next = applyCategoryHints(
      reading([item("Widget", 100000, null)]),
      [
        {
          index: 0,
          name: "Widget",
          categoryId: "99999999-9999-4999-8999-999999999999",
        },
        { index: 5, name: "Widget", categoryId: CAT_TOYS },
      ],
      categories,
    );
    expect(next.items[0].categoryId).toBeNull();
  });

  it("does not change the money: amounts, total and the item count stay", () => {
    const before = reading([item("A", 30000, null), item("B", 70000, null)]);
    const next = applyCategoryHints(
      before,
      [{ index: 1, name: "B", categoryId: CAT_BOOKS }],
      categories,
    );
    expect(next.items.map((i) => i.amount)).toEqual([30000, 70000]);
    expect(next.total).toBe(before.total);
    // The input is not mutated.
    expect(before.items[1].categoryId).toBeNull();
  });
});
