import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import type { AiActionsService } from "../../ai/actions/ai-actions.service";
import { AiReviewRequest } from "../../ai-review/ai-review-request.entity";
import type { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import type { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import type { AiReviewSubmitResult } from "../../ai-review/ai-review-work.types";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { User } from "../../users/entities/user.entity";
import type { PayeesService } from "../../payees/payees.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { EmailReceiptCategoryAiService } from "../ai/email-receipt-category-ai.service";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_CONTRACT_1,
  ALLEGRO_PAY_CONTRACT_2,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
  ALLEGRO_PAY_REPAYMENT_LINES,
  ALLEGRO_PAY_REPAYMENT_SUBJECT,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "../parsing/fixtures/allegro-pay-mails";
import { parseReceiptLines } from "../parsing/parse-receipt";
import type {
  ParsedReceipt,
  ParsedTrade,
} from "../parsing/receipt-parser.types";
import type { TradeOutcome } from "./email-receipt-trade.service";
import {
  autoApplyAllowed,
  describeFailure,
  EmailReceiptPipelineService,
  RECEIPT_NO_HTML_REASON,
  RECEIPT_SCHEMA_ORG_REASON,
  type AutoApplyFacts,
  type ProcessReceiptOptions,
} from "./email-receipt-pipeline.service";
import {
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CHAT_INSTRUCTION,
} from "./receipt-instructions";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const RECEIPT = "receipt-1";
const TX = "tx-1";
const PAYEE = "payee-1";
const CAT_BOOKS = "11111111-1111-4111-8111-111111111111";
const CAT_SHIPPING = "22222222-2222-4222-8222-222222222222";

const DEFINITION = {
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

/** Items 12.00 plus shipping 3.00 is the total 15.00: a complete parse. */
const BODY = [
  "Order number: ABCD1234",
  "Items",
  "Widget 12.00",
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

const parserRow = (
  over: Partial<EmailReceiptParser> = {},
): EmailReceiptParser =>
  Object.assign(new EmailReceiptParser(), {
    id: "parser-1",
    userId: USER,
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition: DEFINITION,
    status: "approved",
    source: "manual",
    revision: 1,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });

const mailboxRow = (over: Partial<EmailReceiptMailbox> = {}) =>
  Object.assign(new EmailReceiptMailbox(), {
    id: "mb-1",
    userId: USER,
    aiMode: "off",
    autoApply: false,
    ...over,
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

const request = (id = "rq-1"): AiReviewRequest =>
  Object.assign(new AiReviewRequest(), { id });

const TRADE_DEFINITION = {
  version: 2,
  trade: {
    action: ["Type: {action}"],
    symbol: ["Symbol: {symbol}"],
    quantity: ["Shares: {quantity}"],
    total: ["Total cost: {amount}"],
    defaultAccountId: "33333333-3333-4333-8333-333333333333",
  },
};

const TRADE_BODY = [
  "Type: Fractional Buy",
  "Symbol: XCNS",
  "Shares: 75.9878",
  "Total cost: $2,000.00",
].join("\n");

const TRADE_READING: ParsedTrade = {
  action: "BUY",
  symbol: "XCNS",
  quantity: 75.9878,
  total: 20_000_000,
  price: null,
  commission: null,
  date: null,
  accountText: null,
  accountId: "33333333-3333-4333-8333-333333333333",
  complete: true,
  consistent: null,
  reason: null,
};

interface World {
  receipt: EmailReceipt | null;
  mailbox: EmailReceiptMailbox;
  parsers: EmailReceiptParser[];
  payee: Partial<Payee> | null;
  /** What `PayeesService.resolveByName` answers for the seller of a schema.org order. */
  sellerPayee: Partial<Payee> | null;
  candidates: Array<Record<string, unknown>>;
  linkRow: Record<string, unknown> | null;
  requestStatus: string | null;
  /** The kind of the request the receipt stands behind; `email_receipt` by default. */
  requestKind?: string;
  /** Linked receipts: what the component search finds (`FROM email_receipts r`). */
  componentRows?: Array<Record<string, unknown>>;
  /** Units-of-money other settlements took from a component (`SUM(part_amount) AS taken`). */
  takenRows?: Array<Record<string, unknown>>;
  /** The component profiles' tags (`definition->>'tag'`). */
  tagRows?: Array<Record<string, unknown>>;
  /** What the link rows say about a component (`COUNT(*) AS used`). */
  usedRow?: Record<string, unknown>;
  /** The settlements waiting for a component's link value (`SELECT s.id`). */
  waitingRows?: Array<Record<string, unknown>>;
  /** The status of a waiting settlement's request (`SELECT q.status`); none when absent. */
  rejoinStatusRows?: Array<Record<string, unknown>>;
  /** The components the deleted link rows named (`RETURNING component_receipt_id`). */
  deletedLinkRows?: Array<Record<string, unknown>>;
  /** The owner's account row (`loadOwnAddresses`); the forward fixtures' Gmail by default. */
  owner?: Partial<User> | null;
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    receipt: receiptRow(),
    mailbox: mailboxRow(),
    parsers: [parserRow()],
    payee: null,
    sellerPayee: null,
    candidates: [candidate()],
    linkRow: null,
    requestStatus: null,
    ...over,
  };
  const receiptRepo = {
    findOne: jest.fn(async () => world.receipt),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mailboxRepo = { findOne: jest.fn(async () => world.mailbox) };
  const userRepo = {
    findOne: jest.fn(async () =>
      world.owner === undefined
        ? {
            id: USER,
            email: "alice.example@gmail.example.com",
            emailVerified: true,
          }
        : world.owner,
    ),
  };
  const parserRepo = { find: jest.fn(async () => world.parsers) };
  const payeeRepo = { findOne: jest.fn(async () => world.payee) };
  const categoryRepo = {
    find: jest.fn(async () => [
      { id: CAT_BOOKS, name: "Books", parentId: null },
      { id: CAT_SHIPPING, name: "Shipping", parentId: null },
    ]),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
    [EmailReceiptMailbox, mailboxRepo],
    [User, userRepo],
    [EmailReceiptParser, parserRepo],
    [Payee, payeeRepo],
    [Category, categoryRepo],
  ]);
  const order: string[] = [];
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("pg_advisory_xact_lock")) {
      order.push("advisory");
      return [];
    }
    if (text.includes("SET status = 'rejected'")) {
      order.push("close");
      return [[], 0];
    }
    if (/SELECT status(, kind)? FROM ai_review_requests/.test(text)) {
      return world.requestStatus === null
        ? []
        : [
            {
              status: world.requestStatus,
              kind: world.requestKind ?? "email_receipt",
            },
          ];
    }
    if (text.includes("SELECT s.id")) return world.waitingRows ?? [];
    if (text.includes("SELECT q.status")) return world.rejoinStatusRows ?? [];
    if (text.includes("RETURNING component_receipt_id"))
      return world.deletedLinkRows ?? [];
    if (text.includes("FROM email_receipts r"))
      return world.componentRows ?? [];
    if (text.includes("SUM(part_amount) AS taken"))
      return world.takenRows ?? [];
    if (text.includes("definition->>'tag'")) return world.tagRows ?? [];
    if (text.includes("COUNT(*) AS used")) {
      return [world.usedRow ?? { used: "0", taken: "0" }];
    }
    if (text.includes("JOIN accounts a")) return world.candidates;
    if (text.includes("WHERE t.id = $1")) {
      return world.linkRow === null ? [] : [world.linkRow];
    }
    return [];
  });

  const requests = {
    enqueueClaimed: jest.fn(async () => {
      order.push("enqueue");
      return request() as AiReviewRequest | null;
    }),
    enqueuePendingForReceipt: jest.fn(async () => {
      order.push("enqueuePending");
      return request("rq-ai") as AiReviewRequest | null;
    }),
    release: jest.fn(async () => null),
  } as unknown as jest.Mocked<AiReviewRequestsService>;
  const work = {
    submit: jest.fn(async () => submitted()),
  } as unknown as jest.Mocked<AiReviewWorkService>;
  const actions = {
    confirm: jest.fn(async () => ({ type: "update_transaction", id: TX })),
  } as unknown as jest.Mocked<AiActionsService>;

  const payees = {
    resolveByName: jest.fn(async () => world.sellerPayee),
  } as unknown as jest.Mocked<PayeesService>;

  const categoryAi = {
    canAnswerNow: jest.fn(async () => true),
    categorize: jest.fn(
      async (): Promise<Map<number, string> | null> => new Map(),
    ),
  } as unknown as jest.Mocked<EmailReceiptCategoryAiService>;

  const trades = {
    process: jest.fn(async (): Promise<TradeOutcome> => ({
      status: "review",
      reason: null,
      requestId: "rq-trade",
      trade: TRADE_READING,
      investmentTransactionId: null,
      autoApply: null,
    })),
  };
  const service = new EmailReceiptPipelineService(
    dataSource as never,
    requests,
    work,
    actions,
    payees,
    categoryAi,
    trades as never,
  );
  return {
    service,
    trades,
    world,
    payees,
    categoryAi,
    manager,
    receiptRepo,
    requests,
    work,
    actions,
    order,
    lastUpdate: () =>
      receiptRepo.update.mock.calls[receiptRepo.update.mock.calls.length - 1],
  };
}

const run = (
  h: ReturnType<typeof setup>,
  options: ProcessReceiptOptions = {},
) => h.service.process(USER, RECEIPT, options);

const queriesOf = (h: ReturnType<typeof setup>, fragment: string) =>
  h.manager.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

/** The text of the purchase for contract 2, read as the profile reads it. */
const COMPONENT_DEFINITION = {
  ...ALLEGRO_PAY_COMPONENT_DEFINITION,
  defaultCategoryId: CAT_BOOKS,
  shippingCategoryId: CAT_SHIPPING,
};
const SETTLEMENT_DEFINITION = {
  ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
  defaultCategoryId: CAT_BOOKS,
};

const COMPONENT_PARSED = parseReceiptLines(
  COMPONENT_DEFINITION,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
  ALLEGRO_PAY_PURCHASE_LINES,
  null,
);

describe("EmailReceiptPipelineService.process: linked receipts", () => {
  const COMPONENT_PARSER = "parser-component";
  const COMPONENT_RECEIPT = "receipt-component";

  const componentWorld = (over: Partial<World> = {}) =>
    setup({
      receipt: receiptRow({
        fromDomain: "shop.example.com",
        subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
        bodyText: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
      }),
      parsers: [
        parserRow({
          id: COMPONENT_PARSER,
          definition: COMPONENT_DEFINITION as never,
        }),
      ],
      ...over,
    });

  const settlementWorld = (over: Partial<World> = {}) =>
    setup({
      receipt: receiptRow({
        fromDomain: "pay.example.com",
        subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
        receivedAt: new Date("2026-01-10T10:00:00Z"),
        bodyText: ALLEGRO_PAY_REPAYMENT_LINES.join("\n"),
      }),
      parsers: [
        parserRow({
          id: "parser-settlement",
          fromDomains: ["pay.example.com"],
          definition: SETTLEMENT_DEFINITION as never,
        }),
      ],
      candidates: [
        candidate({ amount: "-272.8900", transaction_date: "2026-01-10" }),
      ],
      componentRows: [
        {
          id: COMPONENT_RECEIPT,
          link_key: ALLEGRO_PAY_CONTRACT_2,
          subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
          effective_date: "2025-12-15",
          parsed: COMPONENT_PARSED,
          parser_id: COMPONENT_PARSER,
        },
      ],
      tagRows: [{ id: COMPONENT_PARSER, tag: "Allegro" }],
      ...over,
    });

  describe("a component email", () => {
    it("is stored as component with its link key, and never looks for a transaction or opens a request", async () => {
      const h = componentWorld();
      const result = await run(h);
      expect(result).toMatchObject({
        status: "component",
        statusReason: "awaiting_settlement",
        transactionId: null,
        matchKind: null,
        requestId: null,
      });
      expect(h.lastUpdate()[1]).toMatchObject({
        status: "component",
        statusReason: "awaiting_settlement",
        linkKey: ALLEGRO_PAY_CONTRACT_2,
        transactionId: null,
        candidateTransactionIds: [],
        aiReviewRequestId: null,
      });
      expect(queriesOf(h, "JOIN accounts a")).toHaveLength(0);
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
      expect(h.order).toContain("close");
      expect(h.order).not.toContain("advisory");
    });

    it("holds settled when the parts took its whole net, instalment when part of it", async () => {
      let h = componentWorld({ usedRow: { used: "1", taken: "163.0000" } });
      expect((await run(h)).statusReason).toBe("settled");
      h = componentWorld({ usedRow: { used: "2", taken: "100.0000" } });
      expect((await run(h)).statusReason).toBe("instalment");
    });

    it("is parse_failed no_link_key when the email holds no link value", async () => {
      const h = componentWorld({
        receipt: receiptRow({
          fromDomain: "shop.example.com",
          bodyText: ALLEGRO_PAY_PURCHASE_LINES.filter(
            (line) => !line.includes("Allegro Pay") && !line.includes("umowa"),
          ).join("\n"),
        }),
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "no_link_key",
      });
      expect(h.lastUpdate()[1]).toMatchObject({ linkKey: null });
      expect(queriesOf(h, "JOIN accounts a")).toHaveLength(0);
    });

    it("is read as a standalone email when a person links it to a transaction", async () => {
      const h = componentWorld({
        linkRow: {
          id: TX,
          amount: "-163.0000",
          description: null,
          payee_id: null,
          reference_number: null,
          is_transfer: false,
          status: "UNRECONCILED",
          plain: true,
        },
      });
      const result = await run(h, { link: { transactionId: TX } });
      expect(result.status).not.toBe("component");
      expect(result.matchKind).toBe("manual");
      expect(h.lastUpdate()[1]).toMatchObject({ linkKey: null });
    });
  });

  describe("a settlement email", () => {
    it("matches, proposes and stores the joined reading, with its link rows and the component's reason", async () => {
      const h = settlementWorld();
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review",
        statusReason: "partially_linked",
        transactionId: TX,
      });
      const stored = h.lastUpdate()[1].parsed as ParsedReceipt;
      expect(
        stored.items.map((item) => [item.name, item.amount, item.kind]),
      ).toEqual([
        ["Klocki drewniane zestaw", 1098900, undefined],
        ["Kawa ziarnista 250 g", 1400000, "item"],
        ["Filtry papierowe 100 szt.", 100000, "item"],
        ["shipping", 130000, "shipping"],
      ]);
      expect(stored.links?.map((l) => l.outcome)).toEqual([
        "not_found",
        "joined",
      ]);
      const [, values] = queriesOf(h, "INSERT INTO email_receipt_links")[0];
      expect(values).toEqual([
        USER,
        RECEIPT,
        0,
        ALLEGRO_PAY_CONTRACT_1,
        "109.8900",
        null,
        "not_found",
        1,
        ALLEGRO_PAY_CONTRACT_2,
        "163.0000",
        COMPONENT_RECEIPT,
        "joined",
      ]);
      expect(
        queriesOf(h, "UPDATE email_receipts SET status_reason")[0][1],
      ).toEqual(["settled", COMPONENT_RECEIPT, USER]);
      // A reason is written to a row that is still a component only.
      expect(
        String(queriesOf(h, "UPDATE email_receipts SET status_reason")[0][0]),
      ).toContain("status = 'component'");
      const [, , , input] = h.work.submit.mock.calls[0];
      expect(input.tagNames).toEqual(["Allegro"]);
    });

    it("locks the component rows, after the receipt's own row and before the advisory lock", async () => {
      const h = settlementWorld();
      await run(h);
      const sqls = h.manager.query.mock.calls.map(([sql]) => String(sql));
      const lookup = sqls.findIndex((sql) =>
        sql.includes("FROM email_receipts r"),
      );
      const advisory = sqls.findIndex((sql) =>
        sql.includes("pg_advisory_xact_lock"),
      );
      expect(sqls[lookup]).toContain("FOR UPDATE OF r");
      expect(lookup).toBeGreaterThanOrEqual(0);
      expect(lookup).toBeLessThan(advisory);
    });

    it("equals a single-email reading when no component is stored: one line per part", async () => {
      const h = settlementWorld({ componentRows: [] });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review",
        statusReason: "partially_linked",
      });
      const stored = h.lastUpdate()[1].parsed as ParsedReceipt;
      expect(stored.items.map((item) => item.amount)).toEqual([
        1098900, 1630000,
      ]);
      expect(stored.links?.map((l) => l.outcome)).toEqual([
        "not_found",
        "not_found",
      ]);
      expect(
        queriesOf(h, "UPDATE email_receipts SET status_reason"),
      ).toHaveLength(0);
      const [, , , input] = h.work.submit.mock.calls[0];
      expect(input.tagNames).toBeUndefined();
    });

    it("asks for the enriched candidates, a standalone email does not", async () => {
      const h = settlementWorld();
      await run(h);
      expect(queriesOf(h, "LEFT JOIN LATERAL")).toHaveLength(1);
      const standalone = setup();
      await run(standalone);
      expect(queriesOf(standalone, "LEFT JOIN LATERAL")).toHaveLength(0);
      expect(queriesOf(standalone, "applied.status = 'applied'")).toHaveLength(
        1,
      );
    });

    it("replaces the enrichment of a component it joins: proposed as usual", async () => {
      const h = settlementWorld({
        candidates: [
          candidate({
            amount: "-272.8900",
            transaction_date: "2026-01-10",
            enriched_by_receipt_id: COMPONENT_RECEIPT,
          }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({ status: "review", transactionId: TX });
      expect(h.requests.enqueueClaimed).toHaveBeenCalledTimes(1);
    });

    it("is a review_conflict, enriched_by_other, when another email enriched the transaction", async () => {
      const h = settlementWorld({
        candidates: [
          candidate({
            amount: "-272.8900",
            transaction_date: "2026-01-10",
            enriched_by_receipt_id: "receipt-unrelated",
          }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review_conflict",
        statusReason: "enriched_by_other",
        transactionId: null,
        requestId: null,
      });
      expect(h.lastUpdate()[1]).toMatchObject({
        candidateTransactionIds: [TX],
        transactionId: null,
        aiReviewRequestId: null,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(queriesOf(h, "INSERT INTO email_receipt_links")).toHaveLength(1);
    });

    it("never auto-applies a join", async () => {
      const h = settlementWorld({ mailbox: mailboxRow({ autoApply: true }) });
      const result = await run(h);
      expect(result.autoApplied).toBe(false);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });
  });

  describe("a component that arrives after its settlement (spec 8)", () => {
    /** Stub the nested processing of the waiting settlements; the component's own run is real. */
    const spyNested = (h: ReturnType<typeof setup>) => {
      const real = h.service.process.bind(h.service);
      const spy = jest
        .spyOn(h.service, "process")
        .mockImplementation(async (user, id, options) =>
          id === RECEIPT
            ? real(user, id, options)
            : ({ status: "review", unchanged: false } as never),
        );
      return spy;
    };

    it("returns the waiting settlements, newest first, from a query that excludes the component itself", async () => {
      const h = componentWorld({
        waitingRows: [{ id: "settlement-new" }, { id: "settlement-old" }],
        rejoinStatusRows: [{ status: null }],
      });
      const spy = spyNested(h);
      await run(h);
      const [sql, values] = queriesOf(h, "SELECT s.id")[0];
      expect(String(sql)).toContain("l.component_receipt_id IS NULL");
      expect(String(sql)).toContain("ORDER BY COALESCE(s.original_sent_at");
      expect(values).toEqual([USER, RECEIPT, ALLEGRO_PAY_CONTRACT_2, 20]);
      expect(spy.mock.calls.slice(1).map(([, id]) => id)).toEqual([
        "settlement-new",
        "settlement-old",
      ]);
    });

    it("reads a settlement that is not applied again as an ordinary automatic pass", async () => {
      const h = componentWorld({
        waitingRows: [{ id: "settlement-1" }],
        rejoinStatusRows: [{ status: "proposed" }],
      });
      const spy = spyNested(h);
      await run(h);
      expect(spy).toHaveBeenLastCalledWith(USER, "settlement-1", {
        onlyWhenStatusIn: [
          "unmatched",
          "ambiguous",
          "review",
          "review_conflict",
          "parse_failed",
        ],
      });
    });

    it("also reads a settlement with no request at all that way", async () => {
      const h = componentWorld({
        waitingRows: [{ id: "settlement-1" }],
        rejoinStatusRows: [{ status: null }],
      });
      const spy = spyNested(h);
      await run(h);
      expect(spy.mock.calls[1][2]).toMatchObject({
        onlyWhenStatusIn: expect.arrayContaining(["unmatched"]),
      });
    });

    it("re-joins a settlement whose request was applied", async () => {
      const h = componentWorld({
        waitingRows: [{ id: "settlement-1" }],
        rejoinStatusRows: [{ status: "applied" }],
      });
      const spy = spyNested(h);
      await run(h);
      expect(spy).toHaveBeenLastCalledWith(USER, "settlement-1", {
        rejoin: true,
      });
    });

    it("logs a failure of a settlement, goes on to the next and keeps the component's result", async () => {
      const h = componentWorld({
        waitingRows: [{ id: "settlement-1" }, { id: "settlement-2" }],
        rejoinStatusRows: [{ status: "proposed" }],
      });
      const real = h.service.process.bind(h.service);
      const spy = jest
        .spyOn(h.service, "process")
        .mockImplementation(async (user, id, options) => {
          if (id === RECEIPT) return real(user, id, options);
          if (id === "settlement-1") throw new Error("boom with data");
          return { status: "review" } as never;
        });
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const result = await run(h);
      expect(result.status).toBe("component");
      expect(spy.mock.calls.map(([, id]) => id)).toEqual([
        RECEIPT,
        "settlement-1",
        "settlement-2",
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("A waiting settlement could not be read again"),
      );
      warn.mockRestore();
    });

    it("reads nothing again when no settlement waits, and never for a component that failed to read", async () => {
      const h = componentWorld();
      const spy = spyNested(h);
      await run(h);
      expect(spy).toHaveBeenCalledTimes(1);
      const failed = componentWorld({
        receipt: receiptRow({
          fromDomain: "shop.example.com",
          bodyText: ALLEGRO_PAY_PURCHASE_LINES.filter(
            (line) => !line.includes("Allegro Pay") && !line.includes("umowa"),
          ).join("\n"),
        }),
        waitingRows: [{ id: "settlement-1" }],
      });
      const failedSpy = spyNested(failed);
      await run(failed);
      expect(queriesOf(failed, "SELECT s.id")).toHaveLength(0);
      expect(failedSpy).toHaveBeenCalledTimes(1);
    });

    describe("the re-join of an applied settlement", () => {
      /** The reading a settlement stored before its component existed. */
      const storedBefore = async (): Promise<ParsedReceipt> => {
        const first = settlementWorld({ componentRows: [] });
        await run(first);
        return first.lastUpdate()[1].parsed as ParsedReceipt;
      };
      const linkRow = {
        id: TX,
        amount: "-272.8900",
        description: null,
        payee_id: null,
        reference_number: null,
        is_transfer: false,
        status: "UNRECONCILED",
        plain: true,
      };
      const appliedWorld = async (over: Partial<World> = {}) =>
        settlementWorld({
          receipt: receiptRow({
            fromDomain: "pay.example.com",
            subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
            receivedAt: new Date("2026-01-10T10:00:00Z"),
            bodyText: ALLEGRO_PAY_REPAYMENT_LINES.join("\n"),
            status: "review",
            statusReason: "partially_linked",
            transactionId: TX,
            matchKind: "amount_date",
            aiReviewRequestId: "rq-applied",
            parsed: (await storedBefore()) as never,
          }),
          requestStatus: "applied",
          linkRow,
          ...over,
        });

      it("proposes a new card on the stored transaction without matching again", async () => {
        const h = await appliedWorld();
        const result = await run(h, { rejoin: true });
        expect(result).toMatchObject({
          status: "review",
          transactionId: TX,
          matchKind: "amount_date",
          requestId: "rq-1",
          autoApplied: false,
          unchanged: false,
        });
        expect(queriesOf(h, "JOIN accounts a")).toHaveLength(0);
        expect(h.requests.enqueueClaimed).toHaveBeenCalledTimes(1);
        expect(h.lastUpdate()[1]).toMatchObject({
          transactionId: TX,
          matchKind: "amount_date",
          aiReviewRequestId: "rq-1",
        });
        // The applied request is never closed or rewritten.
        expect(queriesOf(h, "SET status = 'rejected'")).toHaveLength(1);
        expect(String(queriesOf(h, "SET status = 'rejected'")[0][0])).toContain(
          "status IN ('pending', 'claimed', 'proposed')",
        );
        expect(queriesOf(h, "INSERT INTO email_receipt_links")).toHaveLength(1);
        expect(
          queriesOf(h, "UPDATE email_receipts SET status_reason")[0][1],
        ).toEqual(["settled", COMPONENT_RECEIPT, USER]);
        expect(h.actions.confirm).not.toHaveBeenCalled();
      });

      it("never auto-applies the new card", async () => {
        const h = await appliedWorld({
          mailbox: mailboxRow({ autoApply: true }),
        });
        const result = await run(h, { rejoin: true });
        expect(result.autoApplied).toBe(false);
        expect(h.actions.confirm).not.toHaveBeenCalled();
      });

      it("writes nothing when no part changed from not joined to joined", async () => {
        const h = await appliedWorld({ componentRows: [] });
        const result = await run(h, { rejoin: true });
        expect(result.unchanged).toBe(true);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
        expect(queriesOf(h, "DELETE FROM email_receipt_links")).toHaveLength(0);
        expect(queriesOf(h, "INSERT INTO email_receipt_links")).toHaveLength(0);
        expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
        expect(h.order).not.toContain("close");
      });

      it("writes nothing when the part was already joined", async () => {
        const stored = await storedBefore();
        const already: ParsedReceipt = {
          ...stored,
          links: stored.links?.map((l) => ({
            ...l,
            outcome: "joined" as const,
          })),
        };
        const h = await appliedWorld();
        (h.world.receipt as EmailReceipt).parsed = already as never;
        const result = await run(h, { rejoin: true });
        expect(result.unchanged).toBe(true);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
      });

      it("leaves a settlement whose request is not applied alone", async () => {
        const h = await appliedWorld({ requestStatus: "proposed" });
        const result = await run(h, { rejoin: true });
        expect(result.unchanged).toBe(true);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
      });

      it("leaves an email that is not read by a settlement profile alone", async () => {
        const h = await appliedWorld({
          parsers: [parserRow({ id: "other", definition: DEFINITION })],
          receipt: receiptRow({
            status: "review",
            transactionId: TX,
            matchKind: "amount_date",
            aiReviewRequestId: "rq-applied",
          }),
        });
        const result = await run(h, { rejoin: true });
        expect(result.unchanged).toBe(true);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
      });

      it("leaves an email with no transaction alone", async () => {
        const h = await appliedWorld();
        (h.world.receipt as EmailReceipt).transactionId = null;
        const result = await run(h, { rejoin: true });
        expect(result.unchanged).toBe(true);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
      });
    });
  });

  describe("an applied email read again as a component (spec 9)", () => {
    const appliedPurchase = (over: Partial<World> = {}) =>
      componentWorld({
        receipt: receiptRow({
          fromDomain: "shop.example.com",
          subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
          bodyText: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
          status: "review",
          transactionId: TX,
          matchKind: "amount_payee",
          aiReviewRequestId: "rq-applied",
        }),
        requestStatus: "applied",
        ...over,
      });

    it("becomes a component, keeps its transaction and the applied request, and answers no 409", async () => {
      const h = appliedPurchase();
      const result = await run(h);
      expect(result).toMatchObject({
        status: "component",
        transactionId: TX,
        matchKind: "amount_payee",
        requestId: "rq-applied",
      });
      expect(h.lastUpdate()[1]).toMatchObject({
        status: "component",
        linkKey: ALLEGRO_PAY_CONTRACT_2,
        transactionId: TX,
        aiReviewRequestId: "rq-applied",
      });
      expect(h.order).not.toContain("close");
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("does the same on an automatic pass that allows review", async () => {
      const h = appliedPurchase();
      const result = await run(h, { onlyWhenStatusIn: ["review"] });
      expect(result.status).toBe("component");
      expect(result.unchanged).toBe(false);
    });

    it("is refused for a person's link", async () => {
      const h = appliedPurchase();
      await expect(
        run(h, { link: { transactionId: TX } }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("keeps the 409 when the chosen profile is a standalone one", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "applied",
      });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("writes nothing, not even the forwarded identity, on an automatic pass over a standalone applied email", async () => {
      const h = setup({
        receipt: receiptRow({
          status: "review",
          aiReviewRequestId: "rq-old",
          fromAddress: "me@mail.example.org",
          fromDomain: "mail.example.org",
          subject: "Fwd: Your order ABCD1234",
          bodyText: [
            "---------- Forwarded message ---------",
            "From: Shop <orders@shop.example.com>",
            "Date: Wed, 9 Sep 2026 at 10:00",
            "Subject: Your order ABCD1234",
            "To: me@mail.example.org",
            "",
            BODY,
          ].join("\n"),
        }),
        requestStatus: "applied",
      });
      const result = await run(h, { onlyWhenStatusIn: ["review"] });
      expect(result.unchanged).toBe(true);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("stays applied and unchanged when the component profile's guard would turn the email aside", async () => {
      const h = appliedPurchase({
        parsers: [
          parserRow({
            id: COMPONENT_PARSER,
            definition: {
              ...COMPONENT_DEFINITION,
              skipIfLine: ["Allegro Pay"],
            } as never,
          }),
        ],
      });
      const result = await run(h, { onlyWhenStatusIn: ["review"] });
      expect(result.unchanged).toBe(true);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it("clears the link rows on every outcome that never reached the join", async () => {
    const h = setup({ receipt: receiptRow({ status: "review" }), parsers: [] });
    await run(h);
    const deletes = queriesOf(h, "DELETE FROM email_receipt_links");
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual([[RECEIPT], USER]);
    expect(queriesOf(h, "INSERT INTO email_receipt_links")).toHaveLength(0);
  });
});

describe("EmailReceiptPipelineService.process", () => {
  describe("the row and who may touch it", () => {
    it("locks the receipt row first and is a 404 for an email that is not the user's", async () => {
      const h = setup({ receipt: null });
      await expect(run(h)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.receiptRepo.findOne).toHaveBeenCalledWith({
        where: { id: RECEIPT, userId: USER },
        lock: { mode: "pessimistic_write" },
      });
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("leaves a row alone when a person's command changed its status since the poll chose it", async () => {
      const h = setup({ receipt: receiptRow({ status: "ignored" }) });
      const result = await run(h, { onlyWhenStatusIn: ["pending"] });
      expect(result).toMatchObject({ status: "ignored", unchanged: true });
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("refuses a skipped email with a 409 and writes nothing", async () => {
      const h = setup({ receipt: receiptRow({ status: "skipped" }) });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("refuses to reprocess or link an email whose proposal was applied, and writes nothing", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "applied",
      });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      await expect(
        run(h, { link: { transactionId: TX } }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      expect(h.order).not.toContain("close");
    });

    it("the poll leaves an applied email alone instead of failing", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "applied",
      });
      const result = await run(h, { onlyWhenStatusIn: ["review"] });
      expect(result.unchanged).toBe(true);
    });

    it("refuses to link an ignored email, but reprocess brings it back", async () => {
      const h = setup({ receipt: receiptRow({ status: "ignored" }) });
      await expect(
        run(h, { link: { transactionId: TX } }),
      ).rejects.toBeInstanceOf(ConflictException);
      const result = await run(h);
      expect(result.status).toBe("review");
    });
  });

  describe("no_parser and parse_failed", () => {
    it("no approved parser for the sender is no_parser, with everything else cleared", async () => {
      const h = setup({
        parsers: [parserRow({ fromDomains: ["other.example.org"] })],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "no_parser",
        transactionId: null,
        requestId: null,
      });
      expect(h.lastUpdate()).toEqual([
        { id: RECEIPT, userId: USER },
        {
          status: "no_parser",
          statusReason: null,
          parserId: null,
          parsed: null,
          trade: null,
          investmentTransactionId: null,
          linkKey: null,
          transactionId: null,
          candidateTransactionIds: [],
          matchKind: null,
          aiReviewRequestId: null,
        },
      ]);
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("loads only approved parsers, for the user", async () => {
      const h = setup();
      await run(h);
      const repo = h.manager.getRepository.mock.results.find(
        (r) => r.value.find && !r.value.update,
      )?.value;
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, status: "approved" },
        }),
      );
    });

    it("a parser whose definition is invalid (a restored {}) is parse_failed parser_invalid", async () => {
      const h = setup({ parsers: [parserRow({ definition: {} })] });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "parser_invalid",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parserId: "parser-1",
        parsed: null,
      });
    });

    it("no total and no order id is parse_failed with the parser's reason, keeping what was read", async () => {
      const h = setup({
        receipt: receiptRow({ bodyText: "hello\nnothing here" }),
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "no_total",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parserId: "parser-1",
        parsed: expect.objectContaining({ total: null, orderId: null }),
      });
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("an order id alone is enough to go on matching", async () => {
      const h = setup({
        receipt: receiptRow({ bodyText: "Order number: ABCD1234" }),
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      expect(result.matchKind).toBe("order_id");
    });
  });

  describe("a parser's line guards (requireLine, skipIfLine, waitIfLine)", () => {
    const guarded = (extra: Record<string, unknown>) => ({
      ...DEFINITION,
      ...extra,
    });

    it("passes over a parser whose requireLine finds no line, and the next parser for the domain reads the email", async () => {
      const h = setup({
        parsers: [
          parserRow({
            id: "parser-a",
            definition: guarded({ requireLine: ["*PayU*"] }),
          }),
          parserRow({
            id: "parser-b",
            createdAt: new Date("2026-09-02T00:00:00Z"),
          }),
        ],
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      expect(h.lastUpdate()?.[1]).toMatchObject({ parserId: "parser-b" });
    });

    it("reads the email with the first parser when its requireLine is met", async () => {
      const h = setup({
        receipt: receiptRow({ bodyText: `PayU\n${BODY}` }),
        parsers: [
          parserRow({
            id: "parser-a",
            definition: guarded({ requireLine: ["*PayU*"] }),
          }),
          parserRow({
            id: "parser-b",
            createdAt: new Date("2026-09-02T00:00:00Z"),
          }),
        ],
      });
      await run(h);
      expect(h.lastUpdate()?.[1]).toMatchObject({ parserId: "parser-a" });
    });

    it("is no_parser when no candidate's requireLine is met", async () => {
      const h = setup({
        parsers: [
          parserRow({ definition: guarded({ requireLine: ["*PayU*"] }) }),
        ],
      });
      const result = await run(h);
      expect(result.status).toBe("no_parser");
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parserId: null,
        parsed: null,
      });
    });

    it("an invalid definition on the way still stops the read as parser_invalid", async () => {
      const h = setup({
        parsers: [
          parserRow({ id: "parser-a", definition: {} }),
          parserRow({
            id: "parser-b",
            createdAt: new Date("2026-09-02T00:00:00Z"),
          }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "parser_invalid",
      });
    });

    it("a skipIfLine match makes the receipt ignored with skip_line, and reads nothing further", async () => {
      const h = setup({
        parsers: [
          parserRow({ definition: guarded({ skipIfLine: ["Subtotal*"] }) }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "ignored",
        statusReason: "skip_line",
        transactionId: null,
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "ignored",
        statusReason: "skip_line",
        parserId: "parser-1",
        parsed: null,
        transactionId: null,
        matchKind: null,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining("JOIN accounts a"),
        expect.anything(),
      );
    });

    it("a waitIfLine match leaves the receipt unmatched with wait_line, for the rematch to read again", async () => {
      const h = setup({
        parsers: [
          parserRow({ definition: guarded({ waitIfLine: ["*Widget*"] }) }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "unmatched",
        statusReason: "wait_line",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "unmatched",
        statusReason: "wait_line",
        parserId: "parser-1",
        parsed: null,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("skip wins over wait", async () => {
      const h = setup({
        parsers: [
          parserRow({
            definition: guarded({
              skipIfLine: ["*Widget*"],
              waitIfLine: ["*Widget*"],
            }),
          }),
        ],
      });
      expect((await run(h)).statusReason).toBe("skip_line");
    });

    it("the rematch reads a wait_line email again from the top: once the line is gone it is parsed and matched", async () => {
      const definition = guarded({ waitIfLine: ["*pending*"] });
      const h = setup({
        receipt: receiptRow({
          status: "unmatched",
          statusReason: "wait_line",
          bodyText: `Payment pending\n${BODY}`,
        }),
        parsers: [parserRow({ definition })],
      });
      const first = await run(h, { onlyWhenStatusIn: ["unmatched"] });
      expect(first).toMatchObject({
        status: "unmatched",
        statusReason: "wait_line",
        unchanged: false,
      });

      // The shop sends the final mail text: the same stored row, read again.
      h.world.receipt = receiptRow({
        status: "unmatched",
        statusReason: "wait_line",
        bodyText: BODY,
      });
      const second = await run(h, { onlyWhenStatusIn: ["unmatched"] });
      expect(second.status).toBe("review");
      expect(second.statusReason).toBeNull();
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parsed: expect.objectContaining({ total: 150000, complete: true }),
        matchKind: "order_id",
      });
    });

    it("a person's own link is a command: no guard holds it back", async () => {
      const h = setup({
        parsers: [
          parserRow({ definition: guarded({ waitIfLine: ["*Widget*"] }) }),
        ],
        linkRow: {
          id: TX,
          amount: "-15.0000",
          description: null,
          payee_id: null,
          is_transfer: false,
          status: "UNRECONCILED",
          plain: true,
        },
      });
      const result = await run(h, { link: { transactionId: TX } });
      expect(result.statusReason).not.toBe("wait_line");
      expect(result.status).toBe("review");
    });
  });

  describe("a profile that discards its emails (discard)", () => {
    const discarding = (discard: "ignore" | "delete", extra = {}) =>
      parserRow({ definition: { ...DEFINITION, discard, ...extra } });

    it("ignore: the email is ignored with profile_ignore, before any guard, and nothing is read or asked", async () => {
      const h = setup({
        parsers: [discarding("ignore", { skipIfLine: ["*Widget*"] })],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "ignored",
        statusReason: "profile_ignore",
        deleted: false,
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "ignored",
        statusReason: "profile_ignore",
        parserId: "parser-1",
        parsed: null,
        transactionId: null,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining("JOIN accounts a"),
        expect.anything(),
      );
    });

    it("delete: the email row is removed with its open requests, and nothing else is written", async () => {
      const h = setup({ parsers: [discarding("delete")] });
      const result = await run(h);
      expect(result).toMatchObject({ deleted: true, unchanged: false });
      expect(h.receiptRepo.delete).toHaveBeenCalledWith({
        id: RECEIPT,
        userId: USER,
      });
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
      expect(
        h.manager.query.mock.calls.some((c) =>
          String(c[0]).includes("SET status = 'rejected'"),
        ),
      ).toBe(true);
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("a person's own link is a command: the profile does not discard the email", async () => {
      const h = setup({
        parsers: [discarding("delete")],
        linkRow: {
          id: TX,
          amount: "-15.0000",
          description: null,
          payee_id: null,
          reference_number: null,
          is_transfer: false,
          status: "UNRECONCILED",
          plain: true,
        },
      });
      const result = await run(h, { link: { transactionId: TX } });
      expect(result).toMatchObject({ status: "review", deleted: false });
      expect(h.receiptRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe("matching", () => {
    it("loads the candidates in one query and says unmatched when none fit", async () => {
      const h = setup({ candidates: [] });
      const result = await run(h);
      expect(result.status).toBe("unmatched");
      const candidateQueries = h.manager.query.mock.calls.filter((c) =>
        String(c[0]).includes("JOIN accounts a"),
      );
      expect(candidateQueries).toHaveLength(1);
      const [sql, params] = candidateQueries[0];
      expect(sql).toContain("is_transfer = false");
      expect(sql).toContain("!= 'VOID'");
      expect(sql).toContain("investment_transactions");
      expect(sql).toContain("applied.status = 'applied'");
      expect(sql).toContain("open_request.rule_id IS NULL");
      expect(params).toEqual([USER, "2026-09-07", "2026-09-24", RECEIPT, 200]);
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "unmatched",
        transactionId: null,
        candidateTransactionIds: [],
        parsed: expect.objectContaining({ total: 150000 }),
      });
    });

    it("two candidates with the same amount and no order id are ambiguous, and their ids are stored", async () => {
      const h = setup({
        receipt: receiptRow({
          bodyText: "Order total: 15.00",
        }),
        candidates: [
          candidate({ id: "tx-b", description: "A" }),
          candidate({ id: "tx-a", description: "B" }),
        ],
      });
      const result = await run(h);
      expect(result.status).toBe("ambiguous");
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "ambiguous",
        transactionId: null,
        candidateTransactionIds: ["tx-a", "tx-b"],
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("stores the parse with every outcome that got that far", async () => {
      const h = setup({ candidates: [] });
      await run(h);
      expect(h.lastUpdate()?.[1].parsed).toMatchObject({
        orderId: "ABCD1234",
        complete: true,
      });
    });
  });

  describe("a forwarded email (the user forwarded the shop's mail from their own address)", () => {
    /** Forwarded 31 days after the purchase: the forward's own date is Sep 10. */
    const FORWARDED_BODY = [
      "Please file this one.",
      "",
      "---------- Forwarded message ---------",
      "From: Example Shop <orders@shop.example.com>",
      "Date: Mon, Aug 10, 2026 at 10:15 AM",
      "Subject: Your order ABCD1234",
      "To: <alice.example@example.com>",
      "",
      BODY,
    ].join("\n");
    const forwarded = (over: Partial<EmailReceipt> = {}) =>
      receiptRow({
        fromAddress: "alice.example@gmail.example.com",
        fromDomain: "gmail.example.com",
        subject: "Fwd: Your order ABCD1234",
        bodyText: FORWARDED_BODY,
        forwardedBy: null,
        originalSentAt: null,
        ...over,
      });
    const identityUpdates = (h: ReturnType<typeof setup>) =>
      h.receiptRepo.update.mock.calls.filter(
        ([, patch]) => "fromAddress" in patch,
      );

    it("heals the identity from the stored text: the shop, its subject, its day, and the forwarder kept", async () => {
      const h = setup({ receipt: forwarded() });

      await run(h);

      expect(identityUpdates(h)).toEqual([
        [
          { id: RECEIPT, userId: USER },
          {
            fromAddress: "orders@shop.example.com",
            fromDomain: "shop.example.com",
            subject: "Your order ABCD1234",
            forwardedBy: "alice.example@gmail.example.com",
            originalSentAt: new Date("2026-08-10T10:15:00.000Z"),
          },
        ],
      ]);
    });

    it("selects the parser by the shop's domain, not the forwarder's", async () => {
      const h = setup({
        receipt: forwarded(),
        candidates: [candidate({ transaction_date: "2026-08-12" })],
      });

      const result = await run(h);

      // gmail.example.com has no parser; shop.example.com does.
      expect(result.status).toBe("review");
      expect(h.lastUpdate()?.[1]).toMatchObject({ parserId: "parser-1" });
    });

    it("does not match a transaction dated near the forward when the purchase was a month earlier", async () => {
      // The default candidate is dated Sep 11, the day after the forward.
      const h = setup({ receipt: forwarded() });

      const result = await run(h);

      expect(result.status).toBe("unmatched");
    });

    it("centres the match window on the purchase day, not the day it was forwarded", async () => {
      const h = setup({ receipt: forwarded(), candidates: [] });

      await run(h);

      const [, params] = h.manager.query.mock.calls.find((c) =>
        String(c[0]).includes("JOIN accounts a"),
      ) as [string, unknown[]];
      // Aug 10 minus 3 days, plus 14 days: not Sep 7 to Sep 24.
      expect(params).toEqual([USER, "2026-08-07", "2026-08-24", RECEIPT, 200]);
    });

    it("a row already healed is not rewritten", async () => {
      const h = setup({
        receipt: forwarded({
          fromAddress: "orders@shop.example.com",
          fromDomain: "shop.example.com",
          subject: "Your order ABCD1234",
          forwardedBy: "alice.example@gmail.example.com",
          originalSentAt: new Date("2026-08-10T10:15:00.000Z"),
        }),
      });

      await run(h);

      expect(identityUpdates(h)).toHaveLength(0);
    });

    it("an email that is no forward is never touched", async () => {
      const h = setup();

      await run(h);

      expect(identityUpdates(h)).toHaveLength(0);
    });

    it("an original date later than the forward is dropped, and the arrival day is used", async () => {
      const h = setup({
        receipt: forwarded({
          bodyText: FORWARDED_BODY.replace("Aug 10, 2026", "Dec 10, 2026"),
        }),
        candidates: [],
      });

      await run(h);

      expect(identityUpdates(h)[0][1].originalSentAt).toBeNull();
      const [, params] = h.manager.query.mock.calls.find((c) =>
        String(c[0]).includes("JOIN accounts a"),
      ) as [string, unknown[]];
      expect(params[1]).toBe("2026-09-07");
    });

    it("heals on reprocess an email stored before forwards were understood", async () => {
      const h = setup({
        receipt: forwarded({ status: "no_parser" }),
        candidates: [candidate({ transaction_date: "2026-08-12" })],
      });

      const result = await h.service.process(USER, RECEIPT);

      expect(result.status).toBe("review");
      expect(identityUpdates(h)).toHaveLength(1);
    });

    it("never reads the owner's addresses for an email that is no forward", async () => {
      const h = setup();

      await run(h);

      expect(
        h.manager.getRepository.mock.calls.some(([entity]) => entity === User),
      ).toBe(false);
    });

    describe("from somebody who is not the owner (A26-H02)", () => {
      it("is not re-identified: the pasted block is text, and the outsider's domain has no parser", async () => {
        const h = setup({
          receipt: forwarded({
            fromAddress: "someone@evil.example",
            fromDomain: "evil.example",
          }),
          candidates: [candidate({ transaction_date: "2026-08-12" })],
        });

        const result = await run(h);

        expect(identityUpdates(h)).toHaveLength(0);
        expect(result.status).toBe("no_parser");
        expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      });

      it("an unverified account email is nobody's", async () => {
        const h = setup({
          receipt: forwarded(),
          owner: {
            id: USER,
            email: "alice.example@gmail.example.com",
            emailVerified: false,
          },
        });

        await run(h);

        expect(identityUpdates(h)).toHaveLength(0);
      });

      it("a row an outsider's block re-identified before the fix is put back under the outsider", async () => {
        const h = setup({
          receipt: forwarded({
            fromAddress: "orders@shop.example.com",
            fromDomain: "shop.example.com",
            subject: "Your order ABCD1234",
            forwardedBy: "someone@evil.example",
            originalSentAt: new Date("2026-08-10T10:15:00.000Z"),
          }),
        });

        const result = await run(h);

        expect(identityUpdates(h)).toEqual([
          [
            { id: RECEIPT, userId: USER },
            {
              fromAddress: "someone@evil.example",
              fromDomain: "evil.example",
              subject: "Your order ABCD1234",
              forwardedBy: null,
              originalSentAt: null,
            },
          ],
        ]);
        expect(result.status).toBe("no_parser");
      });
    });

    it("the owner's forward is proposed but never auto-applied (A26-H02)", async () => {
      const h = setup({
        receipt: forwarded(),
        mailbox: mailboxRow({ autoApply: true }),
        candidates: [candidate({ transaction_date: "2026-08-12" })],
      });

      const result = await run(h);

      expect(result).toMatchObject({ status: "review", autoApplied: false });
      expect(h.work.submit).toHaveBeenCalledTimes(1);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("heals before anything is refused for the state, so a refusal that wrote nothing stays that way", async () => {
      const h = setup({
        receipt: forwarded({ status: "skipped" }),
      });

      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);

      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("proposing", () => {
    it("a match is proposed through the queue and stored as review, all in one transaction", async () => {
      const h = setup();
      const result = await run(h);

      expect(result).toMatchObject({
        status: "review",
        transactionId: TX,
        matchKind: "order_id",
        requestId: "rq-1",
        autoApplied: false,
        unchanged: false,
      });
      expect(h.requests.enqueueClaimed).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        {
          transactionId: TX,
          kind: "email_receipt",
          emailReceiptId: RECEIPT,
          instruction: expect.any(String),
          claimedBy: "email-receipts",
        },
      );
      expect(h.work.submit).toHaveBeenCalledTimes(1);
      const [userArg, claimKey, requestId, input] = h.work.submit.mock.calls[0];
      expect([userArg, claimKey, requestId]).toEqual([
        USER,
        "email-receipts",
        "rq-1",
      ]);
      expect(input.splits).toEqual([
        { categoryName: "Books", amount: -12, memo: "Widget" },
        { categoryName: "Shipping", amount: -3 },
      ]);
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "review",
        statusReason: null,
        parserId: "parser-1",
        transactionId: TX,
        matchKind: "order_id",
        aiReviewRequestId: "rq-1",
      });
      // one transaction for every read and write
      expect(h.manager.query).toBeDefined();
    });

    it("opens one scoped transaction for the whole decision and never a second", async () => {
      const h = setup();
      const { withScopedDb } = jest.requireMock("../../common/db/scoped-db");
      withScopedDb.mockClear();
      await run(h);
      expect(withScopedDb).toHaveBeenCalledTimes(1);
    });

    it("takes the advisory lock and closes the receipt's own open requests before enqueueing", async () => {
      const h = setup();
      await run(h);
      expect(h.order).toEqual(["advisory", "close", "enqueue"]);
    });

    it("takes the receipt row lock before the advisory lock", async () => {
      const h = setup();
      await run(h);
      expect(h.receiptRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        h.manager.query.mock.invocationCallOrder[
          h.manager.query.mock.calls.findIndex((c) =>
            String(c[0]).includes("pg_advisory_xact_lock"),
          )
        ],
      );
    });

    it("an open request somebody else raised for the transaction is review_conflict", async () => {
      const h = setup();
      h.requests.enqueueClaimed.mockResolvedValue(null);
      const result = await run(h);
      expect(result).toMatchObject({
        status: "review_conflict",
        transactionId: TX,
        requestId: null,
      });
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.lastUpdate()?.[1]).toMatchObject({
        status: "review_conflict",
        aiReviewRequestId: null,
        matchKind: "order_id",
      });
    });

    it("a proposal with nothing in it is parse_failed nothing_to_propose, keeping the match", async () => {
      // Incomplete parse whose summary the transaction already carries, its
      // order number already in the Ref #.
      const h = setup({
        receipt: receiptRow({
          bodyText: "Order number: ABCD1234\nOrder total: 15.00",
        }),
        candidates: [
          candidate({
            description: "Shop ABCD1234 order",
            reference_number: "ABCD1234",
          }),
        ],
      });
      const result = await run(h);
      expect(result).toMatchObject({
        status: "parse_failed",
        statusReason: "nothing_to_propose",
        transactionId: TX,
      });
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("a description-only proposal names its reason", async () => {
      // The email says 15.00, the transaction is 14.00: the lines cannot be proposed.
      const h = setup({
        candidates: [
          candidate({ amount: "-14.0000", description: "ABCD1234" }),
        ],
      });
      const result = await run(h);
      expect(result.statusReason).toBe("amount_differs");
      const input = h.work.submit.mock.calls[0][3];
      expect(input.splits).toBeUndefined();
      expect(input.description).toContain("Shop: Widget");
      expect(input.referenceNumber).toBe("ABCD1234");
    });

    it("the parser payee's name is proposed only when the transaction has no payee", async () => {
      const h = setup({
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme Books", defaultCategoryId: null },
        candidates: [candidate({ payee_id: null })],
      });
      await run(h);
      expect(h.work.submit.mock.calls[0][3].payeeName).toBe("Acme Books");

      const other = setup({
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme Books", defaultCategoryId: null },
        candidates: [candidate({ payee_id: "other" })],
      });
      await run(other);
      expect(other.work.submit.mock.calls[0][3].payeeName).toBeUndefined();
    });

    it("rethrows anything that is not a refusal, so the transaction rolls back", async () => {
      const h = setup();
      h.work.submit.mockRejectedValue(new Error("connection lost"));
      await expect(run(h)).rejects.toThrow("connection lost");
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("a refused proposal", () => {
    it("falls back once to the description only", async () => {
      const h = setup();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("lines do not add up"))
        .mockResolvedValueOnce(submitted());
      const result = await run(h);
      expect(h.work.submit).toHaveBeenCalledTimes(2);
      const fallback = h.work.submit.mock.calls[1][3];
      expect(fallback.splits).toBeUndefined();
      expect(fallback.categoryName).toBeUndefined();
      expect(fallback.description).toContain("Shop: Widget");
      expect(fallback.referenceNumber).toBe("ABCD1234");
      expect(result).toMatchObject({
        status: "review",
        statusReason: "proposal_fallback",
        requestId: "rq-1",
      });
      expect(h.requests.release).not.toHaveBeenCalled();
    });

    it("a refused fallback closes the request as rejected with the reason and says proposal_refused", async () => {
      const h = setup();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("lines do not add up"))
        .mockRejectedValueOnce(new NotFoundException("category deleted"));
      const result = await run(h);
      expect(h.requests.release).toHaveBeenCalledWith(
        USER,
        "rq-1",
        "email-receipts",
        { final: true, note: "category deleted" },
      );
      expect(result).toMatchObject({
        status: "review",
        statusReason: "proposal_refused",
        requestId: "rq-1",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        statusReason: "proposal_refused",
        aiReviewRequestId: "rq-1",
      });
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("a description-only proposal that is refused is not retried with itself", async () => {
      const h = setup({ candidates: [candidate({ amount: "-14.0000" })] });
      h.work.submit.mockRejectedValue(new ConflictException("not claimed"));
      const result = await run(h);
      expect(h.work.submit).toHaveBeenCalledTimes(1);
      expect(h.requests.release).toHaveBeenCalledWith(
        USER,
        "rq-1",
        "email-receipts",
        { final: true, note: "not claimed" },
      );
      expect(result.statusReason).toBe("proposal_refused");
    });

    it("bounds the note a refusal leaves", async () => {
      const h = setup({ candidates: [candidate({ amount: "-14.0000" })] });
      h.work.submit.mockRejectedValue(
        new BadRequestException("x".repeat(2000)),
      );
      await run(h);
      expect(
        h.requests.release.mock.calls[0][3].note.length,
      ).toBeLessThanOrEqual(400);
    });
  });

  describe("the AI path", () => {
    const incomplete = BODY.replace("Shipping: 3.00\n", "");

    it("in mode automatic an incomplete parse queues a pending request for the AI and submits nothing", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: incomplete }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      const result = await run(h);
      expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        {
          transactionId: TX,
          emailReceiptId: RECEIPT,
          instruction: RECEIPT_AUTOMATIC_AI_INSTRUCTION,
        },
      );
      expect(RECEIPT_AUTOMATIC_AI_INSTRUCTION.length).toBeLessThanOrEqual(1000);
      expect(RECEIPT_CHAT_INSTRUCTION.length).toBeLessThanOrEqual(1000);
      // The poll tells its own requests from the chat's by this text.
      expect(RECEIPT_CHAT_INSTRUCTION).not.toBe(
        RECEIPT_AUTOMATIC_AI_INSTRUCTION,
      );
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.order).toEqual(["advisory", "close", "enqueuePending"]);
      expect(result).toMatchObject({
        status: "review",
        requestId: "rq-ai",
        statusReason: "items_unbalanced",
      });
    });

    it("asks the AI even when the deterministic proposal would be empty", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: "Order number: ABCD1234" }),
        candidates: [candidate({ description: "Shop ABCD1234 ABCD1234" })],
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalled();
    });

    it("an open request somebody else raised is review_conflict on this path too", async () => {
      const h = setup({
        mailbox: mailboxRow({ aiMode: "automatic" }),
        receipt: receiptRow({ bodyText: incomplete }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      h.requests.enqueuePendingForReceipt.mockResolvedValue(null);
      const result = await run(h);
      expect(result.status).toBe("review_conflict");
    });

    it.each(["off", "on_demand"] as const)(
      "in mode %s the same receipt takes the deterministic path",
      async (aiMode) => {
        const h = setup({
          mailbox: mailboxRow({ aiMode }),
          receipt: receiptRow({ bodyText: incomplete }),
          candidates: [candidate({ amount: "-12.0000" })],
        });
        await run(h);
        expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
        expect(h.requests.enqueueClaimed).toHaveBeenCalled();
      },
    );

    it("in mode automatic a complete parse needs no AI", async () => {
      const h = setup({ mailbox: mailboxRow({ aiMode: "automatic" }) });
      await run(h);
      expect(h.requests.enqueuePendingForReceipt).not.toHaveBeenCalled();
      expect(h.requests.enqueueClaimed).toHaveBeenCalled();
    });
  });

  describe("a person links a transaction", () => {
    const linkRow = (over: Record<string, unknown> = {}) => ({
      id: "tx-9",
      amount: "-15.0000",
      description: "CARD",
      payee_id: null,
      is_transfer: false,
      status: "UNRECONCILED",
      plain: true,
      ...over,
    });

    it("proposes for that transaction with match kind manual and loads no candidates", async () => {
      const h = setup({ linkRow: linkRow() });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result).toMatchObject({
        status: "review",
        transactionId: "tx-9",
        matchKind: "manual",
      });
      expect(
        h.manager.query.mock.calls.some((c) =>
          String(c[0]).includes("JOIN accounts a"),
        ),
      ).toBe(false);
      expect(h.requests.enqueueClaimed.mock.calls[0][2].transactionId).toBe(
        "tx-9",
      );
    });

    it("reads the transaction by id and owner, inside the writing transaction", async () => {
      const h = setup({ linkRow: linkRow() });
      await run(h, { link: { transactionId: "tx-9" } });
      const call = h.manager.query.mock.calls.find((c) =>
        String(c[0]).includes("WHERE t.id = $1"),
      );
      expect(call?.[1]).toEqual(["tx-9", USER]);
    });

    it.each([
      ["not the user's (or absent)", null, NotFoundException],
      ["a transfer", linkRow({ is_transfer: true }), BadRequestException],
      ["VOID", linkRow({ status: "VOID" }), BadRequestException],
      ["an investment row", linkRow({ plain: false }), BadRequestException],
    ])(
      "refuses a transaction that is %s and writes nothing",
      async (_n, row, error) => {
        const h = setup({ linkRow: row });
        await expect(
          run(h, { link: { transactionId: "tx-9" } }),
        ).rejects.toBeInstanceOf(error);
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
        expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
        expect(h.order).not.toContain("close");
      },
    );

    it("proposes even when the parser read no total and no order id", async () => {
      const h = setup({
        linkRow: linkRow(),
        receipt: receiptRow({ bodyText: "Widget\nnothing else" }),
      });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result.status).toBe("review");
      expect(result.matchKind).toBe("manual");
    });

    it("keeps the link when no parser reads the email, so the AI can be asked about it", async () => {
      const h = setup({ linkRow: linkRow(), parsers: [] });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(result).toMatchObject({
        status: "no_parser",
        transactionId: "tx-9",
        matchKind: "manual",
      });
      expect(h.lastUpdate()?.[1]).toMatchObject({
        transactionId: "tx-9",
        matchKind: "manual",
      });
    });

    it("a manual link never auto-applies", async () => {
      const h = setup({
        linkRow: linkRow(),
        mailbox: mailboxRow({ autoApply: true }),
      });
      const result = await run(h, { link: { transactionId: "tx-9" } });
      expect(h.actions.confirm).not.toHaveBeenCalled();
      expect(result.autoApplied).toBe(false);
    });
  });

  describe("reprocessing starts from the top", () => {
    it("a receipt that ends with no request of its own closes the ones it had", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "proposed",
        candidates: [],
      });
      const result = await run(h);
      expect(result.status).toBe("unmatched");
      expect(h.order).toContain("close");
      expect(h.lastUpdate()?.[1].aiReviewRequestId).toBeNull();
    });

    it("a receipt that is proposed again closes its old request before the new one is queued", async () => {
      const h = setup({
        receipt: receiptRow({ status: "review", aiReviewRequestId: "rq-old" }),
        requestStatus: "rejected",
      });
      await run(h);
      expect(h.order).toEqual(["advisory", "close", "enqueue"]);
    });

    it("does not close the request it has just created", async () => {
      const h = setup();
      await run(h);
      expect(h.order.filter((s) => s === "close")).toHaveLength(1);
    });
  });

  describe("auto-apply", () => {
    const ready = () =>
      setup({
        mailbox: mailboxRow({ autoApply: true }),
        parsers: [parserRow()],
      });

    it("applies the card it built through confirm when every condition holds", async () => {
      const h = ready();
      const result = await run(h);
      expect(h.actions.confirm).toHaveBeenCalledTimes(1);
      expect(h.actions.confirm).toHaveBeenCalledWith(USER, {
        actionId: "action-1",
        signature: "sig-1",
        descriptor: action.descriptor,
      });
      expect(result).toMatchObject({ status: "review", autoApplied: true });
    });

    it("confirms after the transaction that stored the proposal has committed", async () => {
      const h = ready();
      const { withScopedDb } = jest.requireMock("../../common/db/scoped-db");
      let insideTransaction = false;
      withScopedDb.mockImplementationOnce(
        async (
          ds: { transaction: (fn: (m: unknown) => unknown) => unknown },
          fn: (m: unknown) => unknown,
        ) => {
          insideTransaction = true;
          try {
            return await ds.transaction(fn);
          } finally {
            insideTransaction = false;
          }
        },
      );
      h.actions.confirm.mockImplementation(async () => {
        expect(insideTransaction).toBe(false);
        return { type: "update_transaction", id: TX } as never;
      });
      await run(h);
      expect(h.actions.confirm).toHaveBeenCalled();
    });

    it("applies on an amount-plus-payee match too", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        parsers: [parserRow({ payeeId: PAYEE })],
        payee: { id: PAYEE, name: "Acme", defaultCategoryId: null },
        receipt: receiptRow({
          bodyText: BODY.replace("Order number: ABCD1234\n", ""),
        }),
        candidates: [candidate({ payee_id: PAYEE, description: "CARD" })],
      });
      const result = await run(h);
      expect(result.matchKind).toBe("amount_payee");
      expect(h.actions.confirm).toHaveBeenCalled();
    });

    it("the mailbox has not opted in: nothing is applied", async () => {
      const h = setup({ mailbox: mailboxRow({ autoApply: false }) });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the match is by amount alone: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        receipt: receiptRow({
          bodyText: BODY.replace("Order number: ABCD1234\n", ""),
        }),
        candidates: [candidate({ description: "CARD" })],
      });
      const result = await run(h);
      expect(result.matchKind).toBe("amount_date");
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the transaction amount differs from the total: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        candidates: [candidate({ amount: "-14.0000" })],
      });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the parse is incomplete: nothing is applied", async () => {
      const h = setup({
        mailbox: mailboxRow({ autoApply: true }),
        receipt: receiptRow({ bodyText: BODY.replace("Shipping: 3.00\n", "") }),
        candidates: [candidate({ amount: "-12.0000" })],
      });
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("the itemized card was refused and the fallback stored: nothing is applied", async () => {
      const h = ready();
      h.work.submit
        .mockRejectedValueOnce(new BadRequestException("no"))
        .mockResolvedValueOnce(submitted());
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("no card was built: nothing is applied", async () => {
      const h = ready();
      h.requests.enqueueClaimed.mockResolvedValue(null);
      await run(h);
      expect(h.actions.confirm).not.toHaveBeenCalled();
    });

    it("a refusal from confirm leaves the proposal in the inbox, is logged without secrets, and is not thrown", async () => {
      const h = ready();
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      h.actions.confirm.mockRejectedValue(
        new BadRequestException("Daily AI write limit reached."),
      );
      const result = await run(h);
      expect(result).toMatchObject({ status: "review", autoApplied: false });
      expect(h.requests.release).not.toHaveBeenCalled();
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("proposal stays in the inbox");
      expect(line).toContain(
        "BadRequestException: Daily AI write limit reached.",
      );
      expect(line).not.toContain("sig-1");
      warn.mockRestore();
    });

    it("an unexpected error from confirm logs only its class", async () => {
      const h = ready();
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      h.actions.confirm.mockRejectedValue(
        new Error("password authentication failed for user monize_user"),
      );
      await run(h);
      expect(String(warn.mock.calls[0][0])).not.toContain("password");
      expect(String(warn.mock.calls[0][0])).toContain("Error");
      warn.mockRestore();
    });
  });
});

describe("autoApplyAllowed", () => {
  const parsed = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
    orderId: "ABCD1234",
    total: 150000,
    paid: null,
    payee: null,
    shipping: null,
    discount: null,
    items: [],
    shippingCategoryId: null,
    discountCategoryId: null,
    complete: true,
    reason: null,
    ...over,
  });
  const facts = (over: Partial<AutoApplyFacts> = {}): AutoApplyFacts => ({
    mailboxAutoApply: true,
    parserStatus: "approved",
    parsed: parsed(),
    transactionAmount: -15,
    matchKind: "order_id",
    proposalKind: "itemized",
    usedFallback: false,
    cardBuilt: true,
    linked: false,
    forwarded: false,
    ...over,
  });

  it("holds when every condition does", () => {
    expect(autoApplyAllowed(facts())).toBe(true);
    expect(autoApplyAllowed(facts({ linked: true }))).toBe(false);
    // A forward's sender is a claim of its text: a person looks (A26-H02).
    expect(autoApplyAllowed(facts({ forwarded: true }))).toBe(false);
    expect(autoApplyAllowed(facts({ matchKind: "amount_payee" }))).toBe(true);
    // The profile's own identifier in the bank operation is as strong as an order number.
    expect(autoApplyAllowed(facts({ matchKind: "reference" }))).toBe(true);
    expect(autoApplyAllowed(facts({ proposalKind: "single_category" }))).toBe(
      true,
    );
    expect(autoApplyAllowed(facts({ transactionAmount: 15 }))).toBe(true);
  });

  it.each(["amount_date", "amount_only", "manual"] as const)(
    "never applies a match by %s: the amount alone is not certain",
    (matchKind) => {
      expect(autoApplyAllowed(facts({ matchKind }))).toBe(false);
    },
  );

  it("still demands the exact amount whatever tolerance the profile matched with", () => {
    expect(
      autoApplyAllowed(
        facts({ matchKind: "amount_payee", transactionAmount: -15.4 }),
      ),
    ).toBe(false);
    expect(
      autoApplyAllowed(
        facts({ matchKind: "reference", transactionAmount: -15.4 }),
      ),
    ).toBe(false);
  });

  it("compares the transaction with the amount paid, else the total", () => {
    const promo = parsed({ total: 150000, paid: 120000 });
    expect(
      autoApplyAllowed(facts({ parsed: promo, transactionAmount: -12 })),
    ).toBe(true);
    expect(
      autoApplyAllowed(facts({ parsed: promo, transactionAmount: -15 })),
    ).toBe(false);
    expect(
      autoApplyAllowed(
        facts({
          parsed: parsed({ total: null, paid: 120000 }),
          transactionAmount: -12,
        }),
      ),
    ).toBe(true);
  });

  it.each<[string, Partial<AutoApplyFacts>]>([
    ["the mailbox has not opted in", { mailboxAutoApply: false }],
    ["the parser is a draft", { parserStatus: "draft" }],
    [
      "the reading came from the email's schema.org markup, not a parser",
      { parsed: parsed({ source: "schema_org" }) },
    ],
    [
      "the parse is incomplete",
      { parsed: parsed({ complete: false, reason: "no_items" }) },
    ],
    ["there is no total", { parsed: parsed({ total: null }) }],
    [
      "paid is stated and the amount equals only the total",
      { parsed: parsed({ total: 150000, paid: 120000 }) },
    ],
    ["the amount differs from the total", { transactionAmount: -14.99 }],
    ["the match is by amount alone", { matchKind: "amount_only" }],
    ["the match is manual", { matchKind: "manual" }],
    ["the proposal is description-only", { proposalKind: "description_only" }],
    ["the fallback was stored", { usedFallback: true }],
    ["no card was built", { cardBuilt: false }],
  ])("is false when %s", (_name, over) => {
    expect(autoApplyAllowed(facts(over))).toBe(false);
  });
});

describe("describeFailure", () => {
  it("names the class, and the message only for an HTTP exception", () => {
    expect(describeFailure(new ConflictException("clash"))).toBe(
      "ConflictException: clash",
    );
    expect(describeFailure(new Error("secret detail"))).toBe("Error");
    expect(describeFailure("text")).toBe("unknown error");
  });
});

/** An email whose HTML carries only what a parser reading it would use. */
const HTML_BODY =
  "<table>" +
  "<tr><td>Order number:</td><td>ABCD1234</td></tr>" +
  "<tr><td>Wrapped product name that the text conversion would split</td><td>12.00</td></tr>" +
  "<tr><td>Order total:</td><td>12.00</td></tr>" +
  "</table>";

const HTML_DEFINITION = {
  version: 2,
  source: "html",
  orderId: [{ label: "Order number:", value: "{orderid}" }],
  total: [{ label: "Order total:", value: "{amount}" }],
  items: {
    startAfter: "Order number:",
    stopAt: "Order total:",
    record: [{ line: "{name}" }, { line: "{amount}" }],
  },
  defaultCategoryId: CAT_BOOKS,
};

describe("EmailReceiptPipelineService.process: the lines source of a parser", () => {
  const candidates12 = [candidate({ amount: "-12.0000" })];

  it("reads the lines of the HTML part for a parser with source html", async () => {
    const h = setup({
      receipt: receiptRow({ bodyText: "unreadable text", bodyHtml: HTML_BODY }),
      parsers: [parserRow({ definition: HTML_DEFINITION })],
      candidates: candidates12,
    });
    const result = await run(h);
    expect(result).toMatchObject({ status: "review", matchKind: "order_id" });
    const stored = h.lastUpdate()?.[1] as {
      parsed: ParsedReceipt;
      parserId: string;
    };
    expect(stored.parserId).toBe("parser-1");
    expect(stored.parsed).toMatchObject({
      orderId: "ABCD1234",
      total: 120000,
      complete: true,
      items: [
        {
          name: "Wrapped product name that the text conversion would split",
          amount: 120000,
        },
      ],
    });
    expect(stored.parsed.source).toBeUndefined();
    expect(h.payees.resolveByName).not.toHaveBeenCalled();
  });

  it("reads the text, not the HTML, for a parser with no source or source text", async () => {
    for (const extra of [{}, { source: "text" }]) {
      const h = setup({
        receipt: receiptRow({ bodyHtml: HTML_BODY }),
        parsers: [parserRow({ definition: { ...DEFINITION, ...extra } })],
      });
      const result = await run(h);
      expect(result.status).toBe("review");
      const stored = h.lastUpdate()?.[1] as { parsed: ParsedReceipt };
      expect(stored.parsed.total).toBe(150000);
    }
  });

  it("applies the parser's guards to the lines of its own source", async () => {
    const guarded = {
      ...HTML_DEFINITION,
      requireLine: ["Wrapped product name*"],
    };
    // The HTML line exists only in the HTML source; the text holds no such line.
    const h = setup({
      receipt: receiptRow({ bodyText: "nothing", bodyHtml: HTML_BODY }),
      parsers: [parserRow({ definition: guarded })],
      candidates: candidates12,
    });
    expect((await run(h)).status).toBe("review");
    const skipped = setup({
      receipt: receiptRow({ bodyText: "nothing", bodyHtml: HTML_BODY }),
      parsers: [
        parserRow({
          definition: { ...HTML_DEFINITION, skipIfLine: ["Order total:"] },
        }),
      ],
    });
    expect(await run(skipped)).toMatchObject({
      status: "ignored",
      statusReason: "skip_line",
    });
  });

  it("is parse_failed no_html for an html parser and an email with no HTML part, keeping the parser and reading nothing", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: null }),
      parsers: [parserRow({ definition: HTML_DEFINITION })],
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "parse_failed",
      statusReason: RECEIPT_NO_HTML_REASON,
    });
    expect(RECEIPT_NO_HTML_REASON).toBe("no_html");
    expect(h.lastUpdate()?.[1]).toMatchObject({
      status: "parse_failed",
      statusReason: "no_html",
      parserId: "parser-1",
      parsed: null,
      aiReviewRequestId: null,
    });
    expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    expect(h.payees.resolveByName).not.toHaveBeenCalled();
  });

  it("an html parser with no HTML to read is passed over for another parser of the sender that reads the text", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: null }),
      parsers: [
        parserRow({ id: "html-parser", definition: HTML_DEFINITION }),
        parserRow({
          id: "text-parser",
          createdAt: new Date("2026-09-02T00:00:00Z"),
        }),
      ],
    });
    const result = await run(h);
    expect(result.status).toBe("review");
    expect(h.lastUpdate()?.[1]).toMatchObject({ parserId: "text-parser" });
  });

  it("keeps a person's link when the parser needs HTML the email lacks: parse_failed no_html on the chosen transaction", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: null }),
      parsers: [parserRow({ definition: HTML_DEFINITION })],
      linkRow: {
        id: "tx-9",
        amount: "-15.0000",
        description: "CARD",
        payee_id: null,
        is_transfer: false,
        status: "UNRECONCILED",
        plain: true,
      },
    });
    const result = await run(h, { link: { transactionId: "tx-9" } });
    expect(result).toMatchObject({
      status: "parse_failed",
      statusReason: "no_html",
      transactionId: "tx-9",
      matchKind: "manual",
    });
  });
});

/** Synthetic JSON-LD in Google's Gmail "Order" shape, paid 15.00 for 12.00 + 3.00. */
const jsonLdOrder = (over: Record<string, unknown> = {}): string =>
  '<html><body><p>Thanks for your order</p><script type="application/ld+json">' +
  JSON.stringify({
    "@context": "http://schema.org",
    "@type": "Order",
    merchant: { "@type": "Organization", name: "Example Shop" },
    orderNumber: "ABCD1234",
    priceCurrency: "USD",
    price: "15.00",
    acceptedOffer: [
      {
        "@type": "Offer",
        itemOffered: { "@type": "Product", name: "Widget" },
        price: "12.00",
        eligibleQuantity: { value: 1 },
      },
      {
        "@type": "Offer",
        itemOffered: { "@type": "Product", name: "Gadget" },
        price: "3.00",
      },
    ],
    ...over,
  }) +
  "</script></body></html>";

const SELLER_PAYEE = {
  id: "seller-1",
  name: "Example Shop",
  defaultCategoryId: CAT_BOOKS,
};

describe("EmailReceiptPipelineService.process: the email's own schema.org order", () => {
  const storedParsed = (h: ReturnType<typeof setup>) =>
    (h.lastUpdate()?.[1] as { parsed: ParsedReceipt }).parsed;

  it("is used when no parser applies: matched, proposed and stored as review with source schema_org", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "review",
      statusReason: RECEIPT_SCHEMA_ORG_REASON,
      matchKind: "order_id",
      transactionId: TX,
      requestId: "rq-1",
    });
    expect(RECEIPT_SCHEMA_ORG_REASON).toBe("schema_org");
    expect(h.lastUpdate()?.[1]).toMatchObject({
      status: "review",
      statusReason: "schema_org",
      parserId: null,
    });
    expect(storedParsed(h)).toEqual({
      orderId: "ABCD1234",
      total: 150000,
      paid: null,
      payee: "Example Shop",
      shipping: null,
      discount: null,
      items: [
        { name: "Widget", qty: 1, amount: 120000, categoryId: CAT_BOOKS },
        { name: "Gadget", qty: 1, amount: 30000, categoryId: CAT_BOOKS },
      ],
      shippingCategoryId: null,
      discountCategoryId: CAT_BOOKS,
      complete: true,
      reason: null,
      source: "schema_org",
    });
    // The seller is looked up, never created; the same proposal path as a parser's.
    expect(h.payees.resolveByName).toHaveBeenCalledWith(USER, "Example Shop");
    const [, , , input] = h.work.submit.mock.calls[0];
    expect(input.splits).toEqual([
      { categoryName: "Books", amount: -12, memo: "Widget" },
      { categoryName: "Books", amount: -3, memo: "Gadget" },
    ]);
  });

  it("labels the proposal's summary by the sender's domain when no parser stands behind it", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
    });
    await run(h);
    const [, , , input] = h.work.submit.mock.calls[0];
    expect(input.description).toContain("shop.example.com: Widget, Gadget");
    expect(input.referenceNumber).toBe("ABCD1234");
  });

  it("is used when the parser found no total and no paid, and keeps that parser on the receipt", async () => {
    const h = setup({
      receipt: receiptRow({
        bodyText: "nothing the parser can read",
        bodyHtml: jsonLdOrder(),
      }),
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "review",
      statusReason: "schema_org",
    });
    expect(storedParsed(h)).toMatchObject({
      source: "schema_org",
      total: 150000,
    });
    expect(h.lastUpdate()?.[1]).toMatchObject({ parserId: "parser-1" });
  });

  it("never replaces a parser that read a total, even when the HTML carries an order", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder({ price: "99.00" }) }),
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result).toMatchObject({ status: "review", statusReason: null });
    expect(storedParsed(h).source).toBeUndefined();
    expect(storedParsed(h).total).toBe(150000);
    expect(h.payees.resolveByName).not.toHaveBeenCalled();
  });

  it("is not used when the order states no total or no item: no parser stays no_parser", async () => {
    for (const over of [
      { price: undefined },
      { acceptedOffer: [] },
      { acceptedOffer: undefined },
    ]) {
      const h = setup({
        receipt: receiptRow({ bodyHtml: jsonLdOrder(over) }),
        parsers: [],
        sellerPayee: SELLER_PAYEE,
      });
      const result = await run(h);
      expect(result.status).toBe("no_parser");
      expect(h.lastUpdate()?.[1]).toMatchObject({
        parsed: null,
        parserId: null,
      });
      expect(h.payees.resolveByName).not.toHaveBeenCalled();
    }
  });

  it("is not used when the HTML has no order markup, malformed JSON-LD, or another type", async () => {
    for (const html of [
      "<p>No markup</p>",
      '<script type="application/ld+json">{broken</script>',
      jsonLdOrder({ "@type": "Product" }),
    ]) {
      const h = setup({
        receipt: receiptRow({ bodyHtml: html }),
        parsers: [],
        sellerPayee: SELLER_PAYEE,
      });
      expect((await run(h)).status).toBe("no_parser");
    }
  });

  it("leaves the parser's own failure when it found nothing and the order is unusable", async () => {
    const h = setup({
      receipt: receiptRow({
        bodyText: "hello\nnothing here",
        bodyHtml: jsonLdOrder({ acceptedOffer: [] }),
      }),
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "parse_failed",
      statusReason: "no_total",
    });
  });

  it("is used only to the end of the same pipeline: an unmatched order is unmatched, reason schema_org, and stored", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      candidates: [],
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "unmatched",
      statusReason: "schema_org",
    });
    expect(storedParsed(h).source).toBe("schema_org");
    expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
  });

  it("is ambiguous when several transactions fit, as a parser's reading would be", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder({ orderNumber: "Z" }) }),
      parsers: [],
      candidates: [candidate({ id: "tx-a" }), candidate({ id: "tx-b" })],
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result.status).toBe("ambiguous");
    expect(h.lastUpdate()?.[1]).toMatchObject({
      statusReason: "schema_org",
      candidateTransactionIds: ["tx-a", "tx-b"],
    });
  });

  it("without a payee for the seller the lines have no category: a description-only proposal that names why (the reason is not overwritten)", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: null,
    });
    const result = await run(h);
    expect(result).toMatchObject({
      status: "review",
      statusReason: "items_uncategorized",
    });
    expect(storedParsed(h)).toMatchObject({
      complete: false,
      reason: "items_uncategorized",
      source: "schema_org",
    });
    const [, , , input] = h.work.submit.mock.calls[0];
    expect(input.splits).toBeUndefined();
    expect(input.categoryName).toBeUndefined();
  });

  it("without a payee that has a default category, a seller found by name is still looked up by name only", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: {
        id: "seller-2",
        name: "Example Shop",
        defaultCategoryId: null,
      },
    });
    const result = await run(h);
    expect(result.statusReason).toBe("items_uncategorized");
    expect(h.payees.resolveByName).toHaveBeenCalledTimes(1);
  });

  it("an order that does not add up is judged by the parser's table: items_unbalanced, description only", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder({ price: "20.00" }) }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
      candidates: [candidate({ amount: "-20.0000" })],
    });
    const result = await run(h);
    expect(result.statusReason).toBe("items_unbalanced");
    expect(storedParsed(h).complete).toBe(false);
  });

  it("asks the AI in mode automatic when the reading is incomplete, as it does for a parser's", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: null,
      mailbox: mailboxRow({ aiMode: "automatic" }),
    });
    const result = await run(h);
    expect(result).toMatchObject({ status: "review", requestId: "rq-ai" });
    expect(h.requests.enqueuePendingForReceipt).toHaveBeenCalledTimes(1);
    expect(h.work.submit).not.toHaveBeenCalled();
  });

  it("never auto-applies: the markup is not an approved parser's reading", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
      mailbox: mailboxRow({ autoApply: true }),
    });
    const result = await run(h);
    expect(result).toMatchObject({ status: "review", autoApplied: false });
    expect(h.actions.confirm).not.toHaveBeenCalled();
  });

  it("serves a person's link: no matching, the order read for the transaction they chose", async () => {
    const h = setup({
      receipt: receiptRow({ bodyHtml: jsonLdOrder() }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
      linkRow: {
        id: "tx-9",
        amount: "-15.0000",
        description: "CARD",
        payee_id: null,
        is_transfer: false,
        status: "UNRECONCILED",
        plain: true,
      },
    });
    const result = await run(h, { link: { transactionId: "tx-9" } });
    expect(result).toMatchObject({
      matchKind: "manual",
      transactionId: "tx-9",
    });
    expect(storedParsed(h).source).toBe("schema_org");
  });

  it("reads a microdata order as well", async () => {
    const microdata =
      '<div itemscope itemtype="http://schema.org/Order">' +
      '<div itemprop="seller" itemscope><meta itemprop="name" content="Example Shop"></div>' +
      '<meta itemprop="orderNumber" content="ABCD1234"><meta itemprop="price" content="15.00">' +
      '<div itemprop="acceptedOffer" itemscope itemtype="http://schema.org/Offer"><div itemprop="itemOffered" itemscope><meta itemprop="name" content="Bundle"></div><meta itemprop="price" content="15.00"></div></div>';
    const h = setup({
      receipt: receiptRow({ bodyHtml: microdata }),
      parsers: [],
      sellerPayee: SELLER_PAYEE,
    });
    const result = await run(h);
    expect(result.status).toBe("review");
    expect(storedParsed(h)).toMatchObject({
      source: "schema_org",
      items: [{ name: "Bundle", amount: 150000 }],
    });
  });

  describe("a trade profile", () => {
    const tradeWorld = () =>
      setup({
        receipt: receiptRow({ bodyText: TRADE_BODY }),
        parsers: [parserRow({ definition: TRADE_DEFINITION })],
      });

    it("hands the lines to the trade reader and stores its reading, matching no bank transaction", async () => {
      const h = tradeWorld();
      const result = await run(h);
      expect(h.trades.process).toHaveBeenCalledTimes(1);
      expect(h.trades.process).toHaveBeenCalledWith(
        h.manager,
        USER,
        expect.objectContaining({ id: RECEIPT }),
        expect.objectContaining({
          lines: TRADE_BODY.split("\n"),
          mailboxAutoApply: false,
        }),
      );
      expect(result).toMatchObject({
        status: "review",
        requestId: "rq-trade",
        transactionId: null,
        matchKind: null,
        autoApplied: false,
      });
      expect(h.lastUpdate()[1]).toMatchObject({
        status: "review",
        parserId: "parser-1",
        parsed: null,
        trade: TRADE_READING,
        aiReviewRequestId: "rq-trade",
      });
      expect(h.work.submit).not.toHaveBeenCalled();
      expect(h.requests.enqueueClaimed).not.toHaveBeenCalled();
    });

    it("does not close the request the trade service just queued", async () => {
      const h = tradeWorld();
      await run(h);
      expect(h.order).not.toContain("close");
    });

    it("closes the requests of an email whose trade holds none", async () => {
      const h = tradeWorld();
      h.trades.process.mockResolvedValueOnce({
        status: "ignored",
        reason: "trade_exists",
        requestId: null,
        trade: TRADE_READING,
        investmentTransactionId: "it-1",
        autoApply: null,
      });
      const result = await run(h);
      expect(result).toMatchObject({ status: "ignored", requestId: null });
      expect(h.order).toContain("close");
      // The email accounts for the row the ledger already held.
      expect(h.lastUpdate()[1]).toMatchObject({
        investmentTransactionId: "it-1",
      });
    });

    it.each(["pending", "claimed", "proposed", "rejected"])(
      "an automatic pass leaves an email whose trade request is %s as it is",
      async (status) => {
        const h = tradeWorld();
        h.world.receipt = receiptRow({
          bodyText: TRADE_BODY,
          status: "review",
          aiReviewRequestId: "rq-trade",
        });
        h.world.requestStatus = status;
        h.world.requestKind = "email_trade";
        const result = await run(h, { onlyWhenStatusIn: ["review"] });
        expect(result.unchanged).toBe(true);
        expect(h.trades.process).not.toHaveBeenCalled();
        expect(h.receiptRepo.update).not.toHaveBeenCalled();
      },
    );

    it("an automatic pass reads again an email whose trade request expired, and a person's reprocess always does", async () => {
      let h = tradeWorld();
      h.world.receipt = receiptRow({
        bodyText: TRADE_BODY,
        status: "review",
        aiReviewRequestId: "rq-trade",
      });
      h.world.requestStatus = "expired";
      h.world.requestKind = "email_trade";
      await run(h, { onlyWhenStatusIn: ["review"] });
      expect(h.trades.process).toHaveBeenCalledTimes(1);

      h = tradeWorld();
      h.world.requestStatus = "proposed";
      h.world.requestKind = "email_trade";
      await run(h);
      expect(h.trades.process).toHaveBeenCalledTimes(1);
    });

    it("refuses a bank-transaction link on an email a trade profile now reads, writing nothing", async () => {
      const h = tradeWorld();
      h.world.linkRow = {
        id: "tx-9",
        amount: "-15.0000",
        description: "CARD",
        payee_id: null,
        is_transfer: false,
        status: "UNRECONCILED",
        plain: true,
      };
      await expect(
        run(h, { link: { transactionId: "tx-9" } }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.trades.process).not.toHaveBeenCalled();
      expect(h.receiptRepo.update).not.toHaveBeenCalled();
    });

    it("refuses to read again an email that accounts for a row, unless that row was only already there", async () => {
      let h = tradeWorld();
      h.world.receipt = receiptRow({
        bodyText: TRADE_BODY,
        investmentTransactionId: "it-1",
        status: "ignored",
        statusReason: "trade_linked",
      });
      await expect(run(h)).rejects.toBeInstanceOf(ConflictException);
      expect(h.receiptRepo.update).not.toHaveBeenCalled();

      h = tradeWorld();
      h.world.receipt = receiptRow({
        bodyText: TRADE_BODY,
        investmentTransactionId: "it-1",
        status: "ignored",
        statusReason: "trade_exists",
      });
      await run(h);
      expect(h.trades.process).toHaveBeenCalledTimes(1);
    });

    it("confirms the card the trade service passed the gate with, as an approval does", async () => {
      const h = tradeWorld();
      h.world.mailbox = mailboxRow({ autoApply: true });
      h.trades.process.mockResolvedValueOnce({
        status: "review",
        reason: null,
        requestId: "rq-trade",
        trade: { ...TRADE_READING, consistent: true },
        investmentTransactionId: null,
        autoApply: action,
      });
      const result = await run(h);
      expect(h.trades.process).toHaveBeenCalledWith(
        h.manager,
        USER,
        expect.anything(),
        expect.objectContaining({ mailboxAutoApply: true }),
      );
      expect(h.actions.confirm).toHaveBeenCalledWith(USER, {
        actionId: action.actionId,
        signature: action.signature,
        descriptor: action.descriptor,
      });
      expect(result.autoApplied).toBe(true);
    });

    it("never reads a trade profile's email as a receipt", async () => {
      const h = tradeWorld();
      await run(h);
      expect(h.manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining("JOIN accounts a"),
        expect.anything(),
      );
    });
  });
});
