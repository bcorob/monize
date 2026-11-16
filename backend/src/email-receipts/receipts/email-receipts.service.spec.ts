import { RECEIPT_TRADE_CHAT_INSTRUCTIONS } from "../pipeline/receipt-instructions";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { MAX_PARSE_LINES } from "../parsing/receipt-parser.types";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { EMAIL_RECEIPT_PROCESSABLE_STATUSES } from "./dto/email-receipts.dto";
import type { EmailReceiptPipelineService } from "../pipeline/email-receipt-pipeline.service";
import {
  deriveDisplayState,
  EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS,
  EMAIL_RECEIPTS_MAX_DOMAINS,
  EmailReceiptsService,
} from "./email-receipts.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
/** The four search bind values of a request with no search and no dates. */
const NO_SEARCH = [null, "all", null, null];
const ID = "receipt-1";

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  from_address: "orders@shop.example.com",
  from_domain: "shop.example.com",
  subject: "Your order",
  received_at: new Date("2026-09-10T10:00:00Z"),
  forwarded_by: null,
  original_sent_at: null,
  created_at: new Date("2026-09-10T10:05:00Z"),
  status: "review",
  status_reason: null,
  match_kind: "order_id",
  parser_id: "p1",
  parser_name: "Shop",
  ai_review_request_id: "rq1",
  request_status: "proposed",
  request_expired: false,
  request_note: null,
  transaction_id: "t1",
  tx_date: "2026-09-11",
  tx_amount: "-37.9700",
  tx_currency: "USD",
  tx_payee: "Shop",
  ...over,
});

function setup() {
  const receiptRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
  ]);
  const pipeline = {
    process: jest.fn(),
  } as unknown as jest.Mocked<EmailReceiptPipelineService>;
  const tradeLinks = {
    candidates: jest.fn(async () => []),
    link: jest.fn(async () => undefined),
  };
  const service = new EmailReceiptsService(
    dataSource as never,
    pipeline,
    tradeLinks as never,
  );
  return { service, manager, receiptRepo, pipeline, tradeLinks };
}

const locked = (over: Partial<EmailReceipt> = {}) =>
  Object.assign(new EmailReceipt(), {
    id: ID,
    userId: USER,
    status: "review",
    transactionId: "t1",
    aiReviewRequestId: "rq1",
    ...over,
  });

describe("deriveDisplayState", () => {
  it.each([
    ["proposed", false, "proposed"],
    ["proposed", true, "expired"],
    ["applied", false, "applied"],
    ["rejected", false, "dismissed"],
    ["expired", false, "expired"],
    ["pending", false, "pending_ai"],
    ["claimed", false, "pending_ai"],
    ["pending", true, "expired"],
  ])("a %s request (expired %s) is %s", (status, expired, expected) => {
    expect(deriveDisplayState("review", { status, expired })).toBe(expected);
  });

  it("a review receipt with no request row is request_missing", () => {
    expect(deriveDisplayState("review", null)).toBe("request_missing");
  });

  it.each([
    "pending",
    "skipped",
    "no_parser",
    "parse_failed",
    "unmatched",
    "ambiguous",
    "review_conflict",
    "ignored",
  ] as const)("a %s receipt shows no request state", (status) => {
    expect(
      deriveDisplayState(status, { status: "proposed", expired: false }),
    ).toBeNull();
  });
});

describe("EmailReceiptsService.list", () => {
  it("shows the investment transaction a trade email accounts for", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row({
        is_trade: true,
        transaction_id: null,
        tx_date: null,
        inv_id: "it-1",
        inv_date: "2026-10-15",
        inv_action: "BUY",
        inv_symbol: "XCNS.TO",
        inv_quantity: "75.98780000",
        inv_total: "2000.0000",
        inv_currency: "CAD",
      }),
    ]);
    const [item] = await service.list(USER, {});
    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain(
      "ON it.id = r.investment_transaction_id AND it.user_id = r.user_id",
    );
    expect(item.investmentTransaction).toEqual({
      id: "it-1",
      date: "2026-10-15",
      action: "BUY",
      symbol: "XCNS.TO",
      quantity: 75.9878,
      totalAmount: 2000,
      currencyCode: "CAD",
    });
  });

  it("marks an email the AI reads as a trade, with no profile reading, as a trade", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row({ is_trade: true, trade_source: "ai", parser_id: null }),
    ]);
    const [item] = await service.list(USER, {});
    const [sql] = manager.query.mock.calls[0];
    // The request kind, not only a profile's reading, makes it a trade.
    expect(sql).toContain(
      "(r.trade IS NOT NULL OR rq.kind = 'email_trade') AS is_trade",
    );
    expect(sql).toContain("WHEN rq.kind = 'email_trade' THEN 'ai'");
    expect(item).toMatchObject({ isTrade: true, tradeSource: "ai" });
  });

  it("lists newest first without the text, deriving the state and the transaction", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row(),
      row({
        id: "receipt-2",
        status: "unmatched",
        request_status: null,
        ai_review_request_id: null,
        transaction_id: null,
        tx_date: null,
        tx_amount: null,
        tx_currency: null,
        tx_payee: null,
        received_at: "2026-09-09T10:00:00.000Z",
      }),
    ]);

    const items = await service.list(USER, { status: "review", limit: 20 });

    const [sql, params] = manager.query.mock.calls[0];
    // The day the shop sent the order (the list's effectiveDate) orders the list.
    expect(sql).toContain(
      "ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id DESC",
    );
    // The text is searched, never selected: look at the column list only.
    expect(sql.slice(0, sql.indexOf("FROM email_receipts"))).not.toContain(
      "body_text",
    );
    expect(params).toEqual([USER, "review", null, null, 20, 0, ...NO_SEARCH]);
    expect(items[0]).toEqual({
      id: ID,
      fromAddress: "orders@shop.example.com",
      fromDomain: "shop.example.com",
      subject: "Your order",
      receivedAt: "2026-09-10T10:00:00.000Z",
      forwardedBy: null,
      originalSentAt: null,
      effectiveDate: "2026-09-10T10:00:00.000Z",
      status: "review",
      statusReason: null,
      matchKind: "order_id",
      parserId: "p1",
      parserName: "Shop",
      linkKey: null,
      aiReviewRequestId: "rq1",
      isTrade: false,
      tradeSource: null,
      displayState: "proposed",
      requestNote: null,
      transaction: {
        id: "t1",
        date: "2026-09-11",
        amount: -37.97,
        currencyCode: "USD",
        payeeName: "Shop",
      },
      investmentTransaction: null,
      createdAt: "2026-09-10T10:05:00.000Z",
    });
    expect(items[1]).toMatchObject({
      displayState: null,
      transaction: null,
      receivedAt: "2026-09-09T10:00:00.000Z",
    });
    expect(Object.keys(items[0])).not.toContain("bodyText");
    expect(Object.keys(items[0])).not.toContain("bodyHtml");
  });

  describe("the sender domain filter", () => {
    it("matches the domain exactly or as a sub-domain, with parameters only, scoped to the user", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([]);
      await service.list(USER, { domain: "shop.example.com" });
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("r.user_id = $1");
      expect(sql).toContain("r.from_domain = $3::varchar");
      expect(sql).toContain("r.from_domain LIKE $4::varchar ESCAPE '\\'");
      expect(sql).not.toContain("shop.example.com");
      expect(params).toEqual([
        USER,
        null,
        "shop.example.com",
        "%.shop.example.com",
        50,
        0,
        ...NO_SEARCH,
      ]);
    });

    it("escapes % _ and backslash in the domain before it becomes a LIKE pattern", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([]);
      await service.list(USER, { domain: "a%b_c\\d.example.com" });
      const params = manager.query.mock.calls[0][1];
      expect(params[2]).toBe("a%b_c\\d.example.com");
      expect(params[3]).toBe("%.a\\%b\\_c\\\\d.example.com");
    });

    it("lower-cases and trims it, and an empty value is no filter", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([]);
      await service.list(USER, { domain: "  Shop.Example.COM " });
      expect(manager.query.mock.calls[0][1][2]).toBe("shop.example.com");
      await service.list(USER, { domain: "   " });
      expect(manager.query.mock.calls[1][1].slice(1, 4)).toEqual([
        null,
        null,
        null,
      ]);
    });

    it("combines with the status filter and the limit in one query", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([]);
      await service.list(USER, {
        status: "no_parser",
        domain: "shop.example.com",
        limit: 7,
      });
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("r.status = $2::varchar");
      expect(params).toEqual([
        USER,
        "no_parser",
        "shop.example.com",
        "%.shop.example.com",
        7,
        0,
        ...NO_SEARCH,
      ]);
    });
  });

  it("never selects the HTML part for the list", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER);
    expect(manager.query.mock.calls[0][0]).not.toContain("body_html");
  });

  it("says who forwarded an email and dates it by the shop's day, not the forward's", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row({
        forwarded_by: "alice.example@gmail.example.com",
        original_sent_at: new Date("2026-08-10T08:15:00Z"),
        received_at: new Date("2026-09-10T10:00:00Z"),
      }),
    ]);

    const [item] = await service.list(USER);

    expect(item).toMatchObject({
      forwardedBy: "alice.example@gmail.example.com",
      originalSentAt: "2026-08-10T08:15:00.000Z",
      receivedAt: "2026-09-10T10:00:00.000Z",
      effectiveDate: "2026-08-10T08:15:00.000Z",
    });
  });

  it("scopes by the JWT user only and clamps the limit", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER);
    expect(manager.query.mock.calls[0][1]).toEqual([
      USER,
      null,
      null,
      null,
      50,
      0,
      ...NO_SEARCH,
    ]);
    await service.list(USER, { limit: 9999 });
    expect(manager.query.mock.calls[1][1][4]).toBe(200);
    await service.list(USER, { limit: 0 });
    expect(manager.query.mock.calls[2][1][4]).toBe(1);
  });

  it("skips `offset` emails after the stable order, as a parameter, and clamps it to 0..100000", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER, { limit: 50, offset: 100 });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(
      /ORDER BY COALESCE\(r\.original_sent_at, r\.received_at\) DESC, r\.id DESC\s+LIMIT \$5 OFFSET \$6/,
    );
    expect(params[5]).toBe(100);
    await service.list(USER, { offset: -5 });
    expect(manager.query.mock.calls[1][1][5]).toBe(0);
    await service.list(USER, { offset: 10_000_000 });
    expect(manager.query.mock.calls[2][1][5]).toBe(100000);
  });

  it("carries why a request was closed", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      row({ request_status: "rejected", request_note: "lines do not add up" }),
    ]);
    const [item] = await service.list(USER);
    expect(item).toMatchObject({
      displayState: "dismissed",
      requestNote: "lines do not add up",
    });
  });
});

describe("the search and the date range", () => {
  const SEARCH = {
    search: "  50%_off\\  ",
    searchIn: "sender" as const,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
  };
  const BOUND = ["%50\\%\\_off\\\\%", "sender", "2026-01-01", "2026-01-31"];

  it("lists with the search bound after the paging values, never in the text", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER, { limit: 7, ...SEARCH });
    const [sql, params] = manager.query.mock.calls[0];
    expect(params).toEqual([USER, null, null, null, 7, 0, ...BOUND]);
    expect(sql).toContain("r.subject ILIKE $7::varchar ESCAPE '\\'");
    expect(sql).toContain("r.body_text ILIKE $7::varchar ESCAPE '\\'");
    expect(sql).toContain("$9::date");
    expect(sql).toContain("$10::date");
    expect(sql).not.toContain("50%");
    expect(sql).not.toContain("2026-01");
  });

  it("counts the states of the emails the search keeps", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.statusCounts(USER, { domain: "shop.example.com", ...SEARCH });
    const [sql, params] = manager.query.mock.calls[0];
    expect(params).toEqual([
      USER,
      "shop.example.com",
      "%.shop.example.com",
      ...BOUND,
    ]);
    expect(sql).toContain("r.from_address ILIKE $4::varchar");
    expect(sql).toContain("$6::date");
  });

  it("lists the sender domains of the emails the search keeps", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.listDomains(USER, { status: "review", ...SEARCH });
    const [sql, params] = manager.query.mock.calls[0];
    expect(params.slice(3)).toEqual(["review", ...BOUND]);
    expect(sql).toContain("r.forwarded_by ILIKE $5::varchar");
    expect(sql).toContain("$7::date");
  });

  it("treats a blank search and blank dates as none", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.list(USER, { search: "   ", dateFrom: "", dateTo: "" });
    expect(manager.query.mock.calls[0][1].slice(6)).toEqual(NO_SEARCH);
  });
});

describe("EmailReceiptsService.listDomains", () => {
  it("lists the user's sender domains with counts, most first then by name, at most 200", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { domain: "a.example.com", count: "5", processable: "3" },
      { domain: "b.example.com", count: 2, processable: 0 },
    ]);
    await expect(service.listDomains(USER)).resolves.toEqual([
      { domain: "a.example.com", count: 5, processable: 3 },
      { domain: "b.example.com", count: 2, processable: 0 },
    ]);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("GROUP BY r.from_domain");
    expect(sql).toContain("ORDER BY count DESC, r.from_domain ASC");
    expect(sql).toContain("r.user_id = $1");
    // `processable` counts the six statuses "process in bulk" can act on again.
    expect(sql).toContain(
      "COUNT(*) FILTER (WHERE r.status = ANY($3::varchar[]))",
    );
    expect(params).toEqual([
      USER,
      200,
      [
        "pending",
        "no_parser",
        "parse_failed",
        "unmatched",
        "ambiguous",
        "review_conflict",
      ],
      null,
      ...NO_SEARCH,
    ]);
    expect(EMAIL_RECEIPTS_MAX_DOMAINS).toBe(200);
  });

  it("counts only the emails in the given status, as a bound parameter", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.listDomains(USER, { status: "review" });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("($4::varchar IS NULL OR r.status = $4::varchar)");
    expect(params[3]).toBe("review");
    expect(sql).not.toContain("review");
  });

  it("is empty for a user with no emails", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(service.listDomains(USER)).resolves.toEqual([]);
  });
});

describe("EmailReceiptsService.listUncoveredDomains", () => {
  it("lists the domains no approved profile covers, with the newest draft naming each, in one statement", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        domain: "a.example.com",
        count: "5",
        draft_parser_id: "p-draft",
        request_id: "req-1",
        request_status: "pending",
      },
      {
        domain: "b.example.com",
        count: 2,
        draft_parser_id: null,
        request_id: null,
        request_status: null,
      },
    ]);
    await expect(service.listUncoveredDomains(USER)).resolves.toEqual([
      {
        domain: "a.example.com",
        count: 5,
        draftParserId: "p-draft",
        pendingRequestId: "req-1",
        pendingRequestStatus: "pending",
      },
      {
        domain: "b.example.com",
        count: 2,
        draftParserId: null,
        pendingRequestId: null,
        pendingRequestStatus: null,
      },
    ]);
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    // only an approved profile covers a domain; a draft reads no mail
    expect(sql).toContain("p.status = 'approved'");
    expect(sql).toContain("p.status = 'draft'");
    // the pipeline's sub-domain rule
    expect(sql).toContain("right(r.from_domain, length(pd.domain) + 1)");
    expect(sql).toContain("ORDER BY d.count DESC, d.domain ASC");
    expect(sql).toContain("r.user_id = $1");
    // the open parser-draft request of the domain, in the same statement
    expect(sql).toContain("q.kind = 'email_parser_draft'");
    expect(sql).toContain("q.parser_domain = d.domain");
    expect(sql).toContain("q.status IN ('pending', 'claimed')");
    expect(sql).toContain("q.expires_at > CURRENT_TIMESTAMP");
    expect(sql).toContain("q.user_id = $1");
    expect(params).toEqual([USER, EMAIL_RECEIPTS_MAX_DOMAINS]);
  });

  it("is empty when every domain is covered", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(service.listUncoveredDomains(USER)).resolves.toEqual([]);
  });
});

describe("EmailReceiptsService.statusCounts", () => {
  it("counts the user's emails per status and their total", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { status: "review", count: "2" },
      { status: "unmatched", count: 5 },
    ]);
    await expect(service.statusCounts(USER)).resolves.toEqual({
      total: 7,
      byStatus: { review: 2, unmatched: 5 },
    });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("r.user_id = $1");
    expect(sql).toContain("GROUP BY r.status");
    expect(params).toEqual([USER, null, null, ...NO_SEARCH]);
  });

  it("limits the count to a domain and its sub-domains, escaped", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(
      service.statusCounts(USER, { domain: " Shop_x.example.com " }),
    ).resolves.toEqual({ total: 0, byStatus: {} });
    expect(manager.query.mock.calls[0][1]).toEqual([
      USER,
      "shop_x.example.com",
      "%.shop\\_x.example.com",
      ...NO_SEARCH,
    ]);
  });
});

describe("EmailReceiptsService.get", () => {
  it("returns the text, the parse and the candidates in the stored order", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([
        {
          ...row({ status: "ambiguous", ai_review_request_id: null }),
          body_text: "Order total: 9.99",
          body_html: "<p>Order total: <b>9.99</b></p>",
          parsed: { total: 99900 },
          candidate_transaction_ids: ["t2", "t1", "gone"],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "t1",
          date: "2026-09-11",
          amount: "-9.9900",
          currency_code: "USD",
          payee_name: null,
          description: "CARD",
        },
        {
          id: "t2",
          date: "2026-09-10",
          amount: "-9.9900",
          currency_code: "USD",
          payee_name: "Shop",
          description: null,
        },
      ]);

    const detail = await service.get(USER, ID);

    expect(detail.bodyText).toBe("Order total: 9.99");
    expect(detail.bodyHtml).toBe("<p>Order total: <b>9.99</b></p>");
    expect(manager.query.mock.calls[0][0]).toContain("r.body_html");
    expect(detail.parsed).toEqual({ total: 99900 });
    expect(detail.trade).toBeNull();
    expect(detail.candidates.map((c) => c.id)).toEqual(["t2", "t1"]);
    expect(detail.candidates[0]).toMatchObject({
      amount: -9.99,
      payeeName: "Shop",
    });
    expect(manager.query.mock.calls[1][1]).toEqual([
      USER,
      ["t2", "t1", "gone"],
    ]);
  });

  it("returns what a trade profile read, and the SELECT asks for it", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      {
        ...row({ status: "review" }),
        body_text: "Symbol: XCNS",
        body_html: null,
        parsed: null,
        trade: { symbol: "XCNS", quantity: 75.9878 },
        candidate_transaction_ids: [],
      },
    ]);
    const detail = await service.get(USER, ID);
    expect(manager.query.mock.calls[0][0]).toContain("r.trade");
    expect(detail.trade).toEqual({ symbol: "XCNS", quantity: 75.9878 });
    expect(detail.parsed).toBeNull();
    expect(detail.candidates).toEqual([]);
  });

  it("returns the trade an open email_trade proposal holds, from the card's preview", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      {
        ...row({ status: "review", is_trade: true, trade_source: "ai" }),
        body_text: "Symbol: XCNS",
        body_html: null,
        parsed: null,
        trade: null,
        trade_proposal: {
          trade: { symbol: "XCNS" },
          action: {
            preview: {
              accountName: "CA RRSP - Brokerage",
              transactionDate: "2026-10-15",
              investmentAction: "BUY",
              symbol: "XCNS",
              securityName: "iShares Core Conservative Balanced ETF Portfolio",
              securityCurrency: "CAD",
              quantity: 75.9878,
              price: 26.3200145286,
              commission: 0,
              totalAmount: 2000,
            },
          },
          proposedAt: "2026-10-16T02:00:00.000Z",
        },
        candidate_transaction_ids: [],
      },
    ]);
    const detail = await service.get(USER, ID);
    const [sql] = manager.query.mock.calls[0];
    // Only a proposal still waiting for approval is shown as the email's trade.
    expect(sql).toContain("AND rq.status = 'proposed'");
    expect(sql).toContain("AND rq.expires_at > CURRENT_TIMESTAMP");
    expect(detail.tradeProposal).toEqual({
      accountName: "CA RRSP - Brokerage",
      date: "2026-10-15",
      action: "BUY",
      symbol: "XCNS",
      securityName: "iShares Core Conservative Balanced ETF Portfolio",
      quantity: 75.9878,
      price: 26.3200145286,
      commission: 0,
      totalAmount: 2000,
      currencyCode: "CAD",
    });
  });

  it("says whose trade request is open: the profile's, or the AI's from Recognize as a trade", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      {
        ...row({ status: "review", is_trade: true, trade_source: "profile" }),
        body_text: "Symbol: XCNS",
        body_html: null,
        parsed: null,
        trade: { symbol: "XCNS", complete: false },
        trade_proposal: null,
        trade_request_source: "ai",
        candidate_transaction_ids: [],
      },
    ]);
    const detail = await service.get(USER, ID);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("rq.instruction = ANY($3::text[])");
    // A request queued before the instruction named dividends is still "ai".
    expect(params).toEqual([USER, ID, [...RECEIPT_TRADE_CHAT_INSTRUCTIONS]]);
    expect(RECEIPT_TRADE_CHAT_INSTRUCTIONS).toHaveLength(2);
    expect(detail.tradeRequestSource).toBe("ai");
  });

  it("has no tradeProposal when the email's request holds none", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      {
        ...row(),
        body_text: "x",
        body_html: null,
        parsed: null,
        trade_proposal: null,
        candidate_transaction_ids: [],
      },
    ]);
    const detail = await service.get(USER, ID);
    expect(detail.tradeProposal).toBeNull();
    expect(detail.tradeRequestSource).toBeNull();
  });

  it("has no bodyHtml for an email with no HTML part", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      {
        ...row(),
        body_text: "x",
        body_html: null,
        parsed: null,
        candidate_transaction_ids: [],
      },
    ]);

    expect((await service.get(USER, ID)).bodyHtml).toBeNull();
  });

  describe("the lines a parser reads and the structured order", () => {
    const HTML =
      "<table><tr><td>Widget</td><td>9,99 zł</td></tr></table>" +
      '<script type="application/ld+json">' +
      JSON.stringify({
        "@type": "Order",
        orderNumber: "SO-1",
        merchant: { name: "Example Shop" },
        price: "9.99",
        acceptedOffer: [{ itemOffered: { name: "Widget" }, price: "9.99" }],
      }) +
      "</script>";
    const detailRow = (over: Record<string, unknown>) => ({
      ...row(),
      body_text: "Widget  9,99 zł\n\nTotal 9,99",
      body_html: null,
      parsed: null,
      candidate_transaction_ids: [],
      ...over,
    });

    it("returns the text lines and the html lines, as each source numbers them", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([detailRow({ body_html: HTML })]);
      const detail = await service.get(USER, ID);
      expect(detail.lines).toEqual({
        text: ["Widget 9,99 zł", "Total 9,99"],
        html: ["Widget", "9,99 zł"],
      });
    });

    it("has no html lines, and no structured order, for an email with no HTML part", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([detailRow({})]);
      const detail = await service.get(USER, ID);
      expect(detail.lines.html).toBeNull();
      expect(detail.lines.text).toEqual(["Widget 9,99 zł", "Total 9,99"]);
      expect(detail.structuredOrder).toBeNull();
    });

    it("returns the schema.org order found in the HTML, in 1/10000 units", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([detailRow({ body_html: HTML })]);
      const detail = await service.get(USER, ID);
      expect(detail.structuredOrder).toEqual({
        orderNumber: "SO-1",
        seller: "Example Shop",
        currency: null,
        orderDate: null,
        total: 99900,
        discount: null,
        items: [{ name: "Widget", qty: 1, unitPrice: 99900, amount: 99900 }],
      });
    });

    it("says not found (null) for HTML with no order markup", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([
        detailRow({ body_html: "<p>Thanks</p>" }),
      ]);
      const detail = await service.get(USER, ID);
      expect(detail.structuredOrder).toBeNull();
      expect(detail.lines.html).toEqual(["Thanks"]);
    });

    it("bounds each list at the parser's line cap", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([
        detailRow({
          body_text: "x\n".repeat(MAX_PARSE_LINES + 50),
          body_html: "<p>x</p>".repeat(MAX_PARSE_LINES + 50),
        }),
      ]);
      const detail = await service.get(USER, ID);
      expect(detail.lines.text).toHaveLength(MAX_PARSE_LINES);
      expect(detail.lines.html).toHaveLength(MAX_PARSE_LINES);
    });

    it("never carries lines or the order in the list", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([row()]);
      const [item] = await service.list(USER, {});
      expect(Object.keys(item)).not.toContain("lines");
      expect(Object.keys(item)).not.toContain("structuredOrder");
      expect(manager.query.mock.calls[0][0]).not.toContain("body_html");
    });
  });

  it("does not look for candidates when there are none", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    await service.get(USER, ID);
    // The row, then the components its link rows name: no candidate query.
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query.mock.calls[1][0]).toContain("email_receipt_links");
  });

  describe("linked receipts (spec 5 and 6)", () => {
    const detailRow = (over: Record<string, unknown> = {}) => ({
      ...row(over),
      body_text: "",
      parsed: null,
      candidate_transaction_ids: [],
    });

    it("carries the link key of a component and the settlements that name it, newest first, one query each, user-scoped", async () => {
      const { service, manager } = setup();
      manager.query
        .mockResolvedValueOnce([
          detailRow({ status: "component", link_key: "1000000002" }),
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: "s2",
            subject: "Repayment",
            effective_at: new Date("2026-01-10T10:00:00Z"),
            part_amount: "163.0000",
            outcome: "joined",
            transaction_id: "t1",
          },
          {
            id: "s1",
            subject: "Earlier repayment",
            effective_at: new Date("2025-12-20T10:00:00Z"),
            part_amount: "50.5000",
            outcome: "scaled",
            transaction_id: null,
          },
        ]);

      const detail = await service.get(USER, ID);

      expect(detail.linkKey).toBe("1000000002");
      expect(detail.linkedComponents).toEqual([]);
      expect(detail.linkedSettlements).toEqual([
        {
          receiptId: "s2",
          subject: "Repayment",
          effectiveDate: "2026-01-10T10:00:00.000Z",
          partAmount: 163,
          outcome: "joined",
          transactionId: "t1",
        },
        {
          receiptId: "s1",
          subject: "Earlier repayment",
          effectiveDate: "2025-12-20T10:00:00.000Z",
          partAmount: 50.5,
          outcome: "scaled",
          transactionId: null,
        },
      ]);
      expect(detail.enrichedBy).toBeNull();
      const [sql, params] = manager.query.mock.calls[2];
      expect(sql).toContain("l.user_id = $1");
      expect(sql).toContain("DESC");
      expect(params).toEqual([USER, ID, 20]);
    });

    it("lists the components of a settlement by part and asks for no settlements of a receipt that is no component", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValueOnce([detailRow()]).mockResolvedValueOnce([
        {
          part_index: 1,
          id: "c1",
          subject: "Purchase",
          effective_at: "2025-12-15T10:00:00.000Z",
        },
      ]);

      const detail = await service.get(USER, ID);

      expect(detail.linkKey).toBeNull();
      expect(detail.linkedComponents).toEqual([
        {
          partIndex: 1,
          receiptId: "c1",
          subject: "Purchase",
          effectiveDate: "2025-12-15T10:00:00.000Z",
        },
      ]);
      expect(detail.linkedSettlements).toEqual([]);
      expect(manager.query).toHaveBeenCalledTimes(2);
      expect(manager.query.mock.calls[1][1]).toEqual([USER, ID]);
    });

    it("names the email whose applied request sits on the candidate of an enriched_by_other conflict", async () => {
      const { service, manager } = setup();
      manager.query
        .mockResolvedValueOnce([
          {
            ...detailRow({
              status: "review_conflict",
              status_reason: "enriched_by_other",
              transaction_id: null,
              tx_date: null,
            }),
            candidate_transaction_ids: ["t9", "t8"],
          },
        ])
        .mockResolvedValueOnce([]) // the candidates
        .mockResolvedValueOnce([]) // the components
        .mockResolvedValueOnce([{ id: "other", subject: "Unrelated" }])
        .mockResolvedValue([]);

      const detail = await service.get(USER, ID);

      expect(detail.enrichedBy).toEqual({
        receiptId: "other",
        subject: "Unrelated",
      });
      const enrichedCall = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("FROM ai_review_requests applied"),
      );
      expect(enrichedCall?.[1]).toEqual([USER, "t9"]);
    });

    it("has no enrichedBy for another conflict reason, or when that email is gone", async () => {
      const { service, manager } = setup();
      manager.query
        .mockResolvedValueOnce([
          {
            ...detailRow({
              status: "review_conflict",
              status_reason: "something_else",
            }),
            candidate_transaction_ids: ["t9"],
          },
        ])
        .mockResolvedValue([]);
      expect((await service.get(USER, ID)).enrichedBy).toBeNull();

      manager.query.mockReset();
      manager.query
        .mockResolvedValueOnce([
          {
            ...detailRow({
              status: "review_conflict",
              status_reason: "enriched_by_other",
            }),
            candidate_transaction_ids: ["t9"],
          },
        ])
        .mockResolvedValue([]);
      expect((await service.get(USER, ID)).enrichedBy).toBeNull();
    });
  });

  it("is a 404 for an email that is not the user's", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(service.get(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptsService.reprocess and link", () => {
  it("reprocess runs the pipeline under the JWT user and returns the fresh detail", async () => {
    const { service, manager, pipeline } = setup();
    pipeline.process.mockResolvedValue({
      status: "review",
      statusReason: null,
      transactionId: null,
      matchKind: null,
      requestId: null,
      autoApplied: false,
      unchanged: false,
      deleted: false,
    });
    manager.query.mockResolvedValueOnce([
      { ...row(), body_text: "", parsed: null, candidate_transaction_ids: [] },
    ]);
    const detail = await service.reprocess(USER, ID);
    expect(pipeline.process).toHaveBeenCalledWith(USER, ID);
    expect(detail?.id).toBe(ID);
  });

  it("reprocess answers null, and reads nothing more, when the email's profile deleted it", async () => {
    const { service, manager, pipeline } = setup();
    pipeline.process.mockResolvedValue({
      status: "review",
      statusReason: null,
      transactionId: null,
      matchKind: null,
      requestId: null,
      autoApplied: false,
      unchanged: false,
      deleted: true,
    });
    await expect(service.reprocess(USER, ID)).resolves.toBeNull();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("link hands the pipeline the transaction, which checks it in the writing transaction", async () => {
    const { service, manager, pipeline, tradeLinks } = setup();
    manager.query
      .mockResolvedValueOnce([{ is_trade: false }])
      .mockResolvedValueOnce([
        {
          ...row(),
          body_text: "",
          parsed: null,
          trade: null,
          candidate_transaction_ids: [],
        },
      ]);
    await service.link(USER, ID, "t9");
    expect(pipeline.process).toHaveBeenCalledWith(USER, ID, {
      link: { transactionId: "t9" },
    });
    expect(tradeLinks.link).not.toHaveBeenCalled();
  });

  it("links a trade email to the investment transaction it reports, not through the bank-transaction pipeline", async () => {
    const { service, manager, pipeline, tradeLinks } = setup();
    manager.query
      .mockResolvedValueOnce([{ is_trade: true }])
      .mockResolvedValueOnce([
        {
          ...row({ status: "ignored" }),
          body_text: "",
          parsed: null,
          trade: { accountId: "a1", symbol: "XCNS", action: "BUY" },
          candidate_transaction_ids: [],
        },
      ]);
    await service.link(USER, ID, "it-9");
    expect(tradeLinks.link).toHaveBeenCalledWith(USER, ID, "it-9");
    expect(pipeline.process).not.toHaveBeenCalled();
    // The detail then offers the investment transactions as its candidates.
    expect(tradeLinks.candidates).toHaveBeenCalledWith(
      manager,
      USER,
      { accountId: "a1", symbol: "XCNS", action: "BUY" },
      expect.any(String),
      ID,
    );
  });

  it("a refusal from the pipeline propagates and nothing is read after it", async () => {
    const { service, manager, pipeline } = setup();
    manager.query.mockResolvedValueOnce([{ is_trade: false }]);
    pipeline.process.mockRejectedValue(new ConflictException("applied"));
    await expect(service.link(USER, ID, "t9")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});

describe("EmailReceiptsService.ignore", () => {
  it("dismisses the receipt's open requests and marks it ignored, under the row lock", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockImplementation(async (sql: string) =>
      /SELECT status(, kind)? FROM ai_review_requests/.test(sql)
        ? [{ status: "proposed" }]
        : sql.includes("FROM email_receipts r")
          ? [
              {
                ...row({ status: "ignored", ai_review_request_id: null }),
                body_text: "",
                parsed: null,
                candidate_transaction_ids: [],
              },
            ]
          : [],
    );

    const detail = await service.ignore(USER, ID);

    expect(receiptRepo.findOne).toHaveBeenCalledWith({
      where: { id: ID, userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    const advisory = sqls.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const close = sqls.findIndex((s) => s.includes("SET status = 'rejected'"));
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(advisory);
    expect(receiptRepo.update).toHaveBeenCalledWith(
      { id: ID, userId: USER },
      {
        status: "ignored",
        statusReason: null,
        aiReviewRequestId: null,
        linkKey: null,
      },
    );
    expect(
      sqls.some((s) => s.includes("DELETE FROM email_receipt_links")),
    ).toBe(true);
    expect(detail.status).toBe("ignored");
  });

  it("refuses an applied receipt and writes nothing", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockResolvedValue([{ status: "applied" }]);
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(receiptRepo.update).not.toHaveBeenCalled();
    expect(
      manager.query.mock.calls.some((c) =>
        String(c[0]).includes("SET status = 'rejected'"),
      ),
    ).toBe(false);
  });

  it("refuses a skipped receipt and writes nothing", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked({ status: "skipped" }));
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(receiptRepo.update).not.toHaveBeenCalled();
  });

  it("ignoring an ignored receipt is a no-op", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked({ status: "ignored" }));
    manager.query
      .mockResolvedValueOnce([
        {
          ...row(),
          body_text: "",
          parsed: null,
          candidate_transaction_ids: [],
        },
      ])
      .mockResolvedValue([]);
    await service.ignore(USER, ID);
    expect(receiptRepo.update).not.toHaveBeenCalled();
  });

  it("is a 404 for another user's email", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(null);
    await expect(service.ignore(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptsService.remove", () => {
  it("dismisses the open request and deletes the email in one transaction", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(locked());
    manager.query.mockResolvedValue([]);

    await service.remove(USER, ID);

    const dismiss = manager.query.mock.calls.find((c) =>
      String(c[0]).includes("SET status = 'rejected'"),
    );
    expect(dismiss?.[1]).toEqual([USER, ID]);
    expect(receiptRepo.delete).toHaveBeenCalledWith({ id: ID, userId: USER });
    expect(
      dismiss && receiptRepo.delete.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      manager.query.mock.invocationCallOrder[
        manager.query.mock.calls.indexOf(dismiss)
      ],
    );
  });

  it("a missing email deletes nothing and closes nothing", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(null);
    await expect(service.remove(USER, ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(receiptRepo.delete).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptsService.overview", () => {
  it("answers the hub's cards from ONE statement, keyed on the user", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        mailbox: {
          enabled: true,
          auth_method: "oauth2",
          ai_mode: "on_demand",
          connected: true,
          last_polled_at: "2026-10-04T11:00:00.000Z",
          last_success_at: "2026-10-04T11:00:00.000Z",
          last_error: null,
          last_error_at: null,
        },
        by_status: {
          pending: 2,
          no_parser: 5,
          unmatched: 1,
          review: 7,
          ignored: 4,
        },
        to_approve: 3,
        parsers: { approved: 2, draft: 1 },
        uncovered: [
          { domain: "shop.example.com", count: 4 },
          { domain: "pay.example.org", count: 1 },
        ],
      },
    ]);

    const overview = await service.overview(USER);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(String(sql)).toContain("user_id = $1");
    // A trade confirmation's proposal waits for approval like a receipt's.
    expect(String(sql)).toContain(
      "rq.kind IN ('email_receipt', 'email_trade')",
    );
    expect(params[0]).toBe(USER);
    expect(overview).toEqual({
      mailbox: {
        enabled: true,
        authMethod: "oauth2",
        aiMode: "on_demand",
        connected: true,
        lastPolledAt: "2026-10-04T11:00:00.000Z",
        lastSuccessAt: "2026-10-04T11:00:00.000Z",
        lastError: null,
        lastErrorAt: null,
      },
      emailsByStatus: {
        pending: 2,
        no_parser: 5,
        unmatched: 1,
        review: 7,
        ignored: 4,
      },
      // pending + no_parser + parse_failed + unmatched + ambiguous + review_conflict
      processable: 8,
      proposalsToApprove: 3,
      parsers: { approved: 2, draft: 1 },
      domainsWithoutProfile: [
        { domain: "shop.example.com", count: 4 },
        { domain: "pay.example.org", count: 1 },
      ],
    });
  });

  it("is empty and names no mailbox for a user with nothing yet", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        mailbox: null,
        by_status: null,
        to_approve: 0,
        parsers: { approved: 0, draft: 0 },
        uncovered: null,
      },
    ]);
    expect(await service.overview(USER)).toEqual({
      mailbox: null,
      emailsByStatus: {},
      processable: 0,
      proposalsToApprove: 0,
      parsers: { approved: 0, draft: 0 },
      domainsWithoutProfile: [],
    });
  });

  it("reads a disconnected OAuth2 mailbox as not connected", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        mailbox: {
          enabled: true,
          auth_method: "oauth2",
          ai_mode: "off",
          connected: false,
          last_polled_at: null,
          last_success_at: null,
          last_error: "Reconnect it",
          last_error_at: "2026-10-04T10:00:00.000Z",
        },
        by_status: null,
        to_approve: 0,
        parsers: { approved: 0, draft: 0 },
        uncovered: null,
      },
    ]);
    const overview = await service.overview(USER);
    expect(overview.mailbox).toMatchObject({
      connected: false,
      lastError: "Reconnect it",
    });
  });

  it("counts a domain no profile covers by the same predicate the automatic draft step uses", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        mailbox: null,
        by_status: null,
        to_approve: 0,
        parsers: { approved: 0, draft: 0 },
        uncovered: [],
      },
    ]);
    await service.overview(USER);
    const sql = String(manager.query.mock.calls[0][0]);
    expect(sql).toContain("r.status = 'no_parser'");
    expect(sql).toContain("unnest(p.from_domains)");
    expect(sql).toContain("kind IN ('email_receipt', 'email_trade')");
    expect(sql).toContain("rq.status = 'proposed'");
    expect(sql).toContain("rq.expires_at > CURRENT_TIMESTAMP");
  });

  it("is a statement of reads only", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        mailbox: null,
        by_status: null,
        to_approve: 0,
        parsers: {},
        uncovered: null,
      },
    ]);
    await service.overview(USER);
    expect(String(manager.query.mock.calls[0][0]).trim()).toMatch(/^SELECT/);
  });
});

describe("EmailReceiptsService.processBatch", () => {
  const SINCE = "2026-10-04T12:00:00.123456Z";

  /** The statements a run issues: the cutoff, the selection, the count of what is left. */
  function batch(ids: string[], remaining = 0, since = SINCE) {
    const h = setup();
    h.manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("AS since")) return [{ since }];
      if (text.includes("SELECT r.id")) return ids.map((id) => ({ id }));
      if (text.includes("COUNT(*)::int AS remaining")) return [{ remaining }];
      return [];
    });
    return h;
  }

  const result = (status: string, over: Record<string, unknown> = {}) => ({
    status,
    statusReason: null,
    transactionId: null,
    matchKind: null,
    requestId: null,
    autoApplied: false,
    unchanged: false,
    deleted: false,
    ...over,
  });

  it("runs the pipeline over the selected emails one after the other and counts where each ended", async () => {
    const h = batch(["a", "b", "c"], 4);
    h.pipeline.process
      .mockResolvedValueOnce(result("review") as never)
      .mockResolvedValueOnce(result("unmatched") as never)
      .mockResolvedValueOnce(result("review") as never);

    const out = await h.service.processBatch(USER, {});

    expect(h.pipeline.process.mock.calls.map((c) => c[1])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(out).toEqual({
      processed: 3,
      byOutcome: { review: 2, unmatched: 1 },
      deleted: 0,
      failed: 0,
      remaining: 4,
      since: SINCE,
    });
  });

  describe("an applied email a component profile covers (linked receipts spec 9)", () => {
    const batchWithReread = (rows: Array<{ id: string; reread: boolean }>) => {
      const h = setup();
      h.manager.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("AS since")) return [{ since: SINCE }];
        if (text.includes("SELECT r.id")) return rows;
        if (text.includes("COUNT(*)::int AS remaining"))
          return [{ remaining: 0 }];
        return [];
      });
      return h;
    };
    const selectionSqls = (h: ReturnType<typeof batchWithReread>) =>
      h.manager.query.mock.calls
        .map(([sql]) => String(sql))
        .filter(
          (sql) =>
            sql.includes("SELECT r.id") ||
            sql.includes("COUNT(*)::int AS remaining"),
        );

    it("selects them with the default statuses, in the batch and in the remaining count", async () => {
      const h = batchWithReread([]);
      await h.service.processBatch(USER, {});
      const sqls = selectionSqls(h);
      expect(sqls).toHaveLength(2);
      for (const sql of sqls) {
        expect(sql).toContain("r.link_key IS NULL");
        expect(sql).toContain("applied_rq.status = 'applied'");
        expect(sql).toContain("cp.definition->>'role' = 'component'");
        expect(sql).toContain("cp.status = 'approved'");
      }
    });

    it("selects none of them when the caller names the statuses", async () => {
      const h = batchWithReread([]);
      await h.service.processBatch(USER, { statuses: ["pending"] });
      for (const sql of selectionSqls(h)) {
        expect(sql).not.toContain("applied_rq");
      }
    });

    it("lets the pipeline act on review for those emails only", async () => {
      const h = batchWithReread([
        { id: "applied", reread: true },
        { id: "plain", reread: false },
      ]);
      h.pipeline.process.mockResolvedValue(result("component") as never);
      await h.service.processBatch(USER, {});
      const [first, second] = h.pipeline.process.mock.calls;
      expect(first[2]?.onlyWhenStatusIn).toEqual([
        ...EMAIL_RECEIPT_PROCESSABLE_STATUSES,
        "review",
      ]);
      expect(second[2]?.onlyWhenStatusIn).toEqual([
        ...EMAIL_RECEIPT_PROCESSABLE_STATUSES,
      ]);
    });

    it("passes over one the pipeline left as it was, so the run does not select it again", async () => {
      const h = batchWithReread([{ id: "applied", reread: true }]);
      h.pipeline.process.mockResolvedValue(
        result("review", { unchanged: true }) as never,
      );
      const out = await h.service.processBatch(USER, {});
      expect(out.processed).toBe(0);
      expect(
        h.manager.query.mock.calls.some(([sql]) =>
          String(sql).includes("SET status_reason = status_reason"),
        ),
      ).toBe(true);
    });
  });

  it("is sequential: the next email starts after the previous one finished", async () => {
    const h = batch(["a", "b"]);
    const order: string[] = [];
    h.pipeline.process.mockImplementation((async (_u: string, id: string) => {
      order.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${id}`);
      return result("review");
    }) as never);
    await h.service.processBatch(USER, {});
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("guards each email by the statuses it was selected for, and gives them one shared AI budget", async () => {
    const h = batch(["a", "b"]);
    h.pipeline.process.mockResolvedValue(result("review") as never);
    await h.service.processBatch(USER, { statuses: ["pending", "no_parser"] });
    const [first, second] = h.pipeline.process.mock.calls;
    expect(first[2]).toMatchObject({
      onlyWhenStatusIn: ["pending", "no_parser"],
    });
    expect(first[2]?.aiCategoryBudget).toBe(second[2]?.aiCategoryBudget);
    expect(first[2]?.aiCategoryBudget?.remaining).toBe(
      EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS,
    );
  });

  it("counts an email its profile deleted as processed and deleted, under no status", async () => {
    const h = batch(["a", "b"]);
    h.pipeline.process
      .mockResolvedValueOnce(result("pending", { deleted: true }) as never)
      .mockResolvedValueOnce(result("review") as never);
    const out = await h.service.processBatch(USER, {});
    expect(out).toMatchObject({
      processed: 2,
      deleted: 1,
      byOutcome: { review: 1 },
    });
  });

  it("does not count an email the pipeline left as it was", async () => {
    const h = batch(["a", "b"]);
    h.pipeline.process
      .mockResolvedValueOnce(result("review", { unchanged: true }) as never)
      .mockResolvedValueOnce(result("review") as never);
    const out = await h.service.processBatch(USER, {});
    expect(out.processed).toBe(1);
    expect(out.byOutcome).toEqual({ review: 1 });
  });

  it("selects the user's emails in the given statuses (all six by default), oldest first, up to the limit, not touched since the run began", async () => {
    const h = batch([]);
    await h.service.processBatch(USER, { limit: 25 });
    const select = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("SELECT r.id"),
    ) as [string, unknown[]];
    expect(select[0]).toContain("r.user_id = $1");
    expect(select[0]).toContain("r.status = ANY($2::varchar[])");
    expect(select[0]).toContain("r.updated_at < $5::timestamptz");
    expect(select[0]).toContain("ORDER BY r.received_at ASC, r.id ASC");
    expect(select[1]).toEqual([
      USER,
      [
        "pending",
        "no_parser",
        "parse_failed",
        "unmatched",
        "ambiguous",
        "review_conflict",
      ],
      null,
      null,
      SINCE,
      25,
    ]);
  });

  it("clamps the limit to 1..200 and defaults it to 100", async () => {
    const limitOf = async (limit?: number) => {
      const h = batch([]);
      await h.service.processBatch(USER, { limit });
      const select = h.manager.query.mock.calls.find((c) =>
        String(c[0]).includes("SELECT r.id"),
      ) as [string, unknown[]];
      return select[1][5];
    };
    expect(await limitOf(undefined)).toBe(100);
    expect(await limitOf(0)).toBe(1);
    expect(await limitOf(5000)).toBe(200);
  });

  it("filters by sender domain or one of its sub-domains, with the LIKE specials taken literally", async () => {
    const h = batch([]);
    await h.service.processBatch(USER, { domain: "Shop_1.Example.com " });
    const select = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("SELECT r.id"),
    ) as [string, unknown[]];
    expect(select[1][2]).toBe("shop_1.example.com");
    expect(select[1][3]).toBe("%.shop\\_1.example.com");
  });

  it("takes the run's cutoff from the first call and gives it back; a later call sends it again and is clamped to now by the database", async () => {
    const h = batch([]);
    await h.service.processBatch(USER, {
      since: "2026-10-04T11:59:59.000000Z",
    });
    const stamp = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("AS since"),
    ) as [string, unknown[]];
    expect(stamp[1]).toEqual(["2026-10-04T11:59:59.000000Z"]);
    expect(stamp[0]).toContain("LEAST(");
    expect(stamp[0]).toContain("CURRENT_TIMESTAMP");
  });

  it("counts what is left with the same filter and the same cutoff, so a run ends", async () => {
    const h = batch(["a"], 0);
    h.pipeline.process.mockResolvedValue(result("unmatched") as never);
    const out = await h.service.processBatch(USER, {
      domain: "shop.example.com",
    });
    const count = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("COUNT(*)::int AS remaining"),
    ) as [string, unknown[]];
    expect(count[0]).toContain("r.updated_at < $5::timestamptz");
    expect(count[1]).toEqual([
      USER,
      expect.any(Array),
      "shop.example.com",
      "%.shop.example.com",
      SINCE,
    ]);
    expect(out.remaining).toBe(0);
  });

  it("passes over an email that raised an error: counts it, touches it so the run does not take it again, and goes on", async () => {
    const h = batch(["a", "b"], 0);
    h.pipeline.process
      .mockRejectedValueOnce(new ConflictException("applied"))
      .mockResolvedValueOnce(result("review") as never);

    const out = await h.service.processBatch(USER, {});

    expect(out).toMatchObject({
      processed: 1,
      failed: 1,
      byOutcome: { review: 1 },
    });
    const touch = h.manager.query.mock.calls.find((c) =>
      String(c[0]).includes("SET status_reason = status_reason"),
    ) as [string, unknown[]];
    expect(touch[1]).toEqual(["a", USER]);
  });

  it("does not fail the run when marking a failed email also fails", async () => {
    const h = batch(["a"], 0);
    h.pipeline.process.mockRejectedValue(new Error("boom"));
    const base = h.manager.query.getMockImplementation() as (
      sql: string,
    ) => Promise<unknown>;
    h.manager.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status_reason = status_reason")) {
        throw new Error("also down");
      }
      return base(sql);
    });
    await expect(h.service.processBatch(USER, {})).resolves.toMatchObject({
      failed: 1,
    });
  });

  it("never runs more than the selection: an empty one is a quiet answer", async () => {
    const h = batch([], 0);
    const out = await h.service.processBatch(USER, {});
    expect(h.pipeline.process).not.toHaveBeenCalled();
    expect(out).toEqual({
      processed: 0,
      byOutcome: {},
      deleted: 0,
      failed: 0,
      remaining: 0,
      since: SINCE,
    });
  });
});

describe("EmailReceiptsService.bulk", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const D = "44444444-4444-4444-8444-444444444444";
  const E = "55555555-5555-4555-8555-555555555555";

  const locked = (
    id: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    status: "no_parser",
    transaction_id: null,
    request_status: null,
    ...over,
  });

  /** Routes each statement of the transaction to a canned answer, in the order they ran. */
  function bulkSetup(rows: Array<Record<string, unknown>>) {
    const h = setup();
    h.manager.query.mockImplementation(async (sql: string, args: unknown[]) => {
      const text = String(sql);
      if (text.includes("FOR UPDATE")) return rows;
      if (text.includes("RETURNING id")) {
        const ids = args[0] as string[];
        return [ids.map((id) => ({ id })), ids.length];
      }
      return [];
    });
    return h;
  }

  const statements = (h: ReturnType<typeof setup>) =>
    h.manager.query.mock.calls.map(([sql]) => String(sql));
  const writes = (h: ReturnType<typeof setup>) =>
    statements(h).filter((sql) => /^\s*(DELETE|UPDATE)\b/.test(sql));

  it("deletes the emails it was told, closing their open requests first", async () => {
    const h = bulkSetup([locked(A), locked(B)]);
    const out = await h.service.bulk(USER, "delete", { ids: [A, B] }, 2);
    expect(out).toEqual({
      affected: 2,
      skippedLinked: 0,
      unchanged: 0,
      notIgnorable: 0,
    });
    const sql = statements(h);
    const lock = sql.findIndex((s) => s.includes("FOR UPDATE OF r"));
    const close = sql.findIndex((s) => s.includes("UPDATE ai_review_requests"));
    const del = sql.findIndex((s) =>
      s.startsWith("DELETE FROM email_receipts"),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(lock);
    expect(del).toBeGreaterThan(close);
    const [closeSql, closeArgs] = h.manager.query.mock.calls[close];
    expect(closeSql).toContain("email_receipt_id = ANY($2::uuid[])");
    expect(closeArgs).toEqual([USER, [A, B]]);
    expect(h.manager.query.mock.calls[del][1]).toEqual([[A, B], USER]);
  });

  it("keys every statement on the user, so another user's ids are never touched", async () => {
    const h = bulkSetup([locked(A)]);
    await h.service.bulk(USER, "delete", { ids: [A, B, C] }, 1);
    for (const [sql, args] of h.manager.query.mock.calls) {
      expect(String(sql)).toMatch(/user_id = \$\d/);
      expect(args).toContain(USER);
    }
    // an id of another user simply does not match, so the count refuses it
    await expect(
      h.service.bulk(USER, "delete", { ids: [A, B, C] }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("reads a filter through the list's predicate: status, domain and its sub-domains", async () => {
    const h = bulkSetup([locked(A), locked(B), locked(C)]);
    await h.service.bulk(
      USER,
      "delete",
      { filter: { status: "no_parser", domain: " Gmail.com " } },
      3,
    );
    const [sql, args] = h.manager.query.mock.calls[0];
    expect(String(sql)).toContain("r.from_domain LIKE $5::varchar ESCAPE");
    expect(String(sql)).toContain("ORDER BY r.id");
    expect(args).toEqual([
      USER,
      20001,
      "no_parser",
      "gmail.com",
      "%.gmail.com",
      [],
      [],
      [],
      null,
      null,
      ...NO_SEARCH,
    ]);
  });

  it("reads the exclusions and the received days of a filter as bind values", async () => {
    const h = bulkSetup([locked(A)]);
    await h.service.bulk(
      USER,
      "delete",
      {
        filter: {
          excludeStatuses: ["ignored"],
          excludeDomains: ["gmail.com"],
          receivedFrom: "2026-01-01",
          receivedTo: "2026-01-31",
        },
      },
      1,
    );
    const [sql, args] = h.manager.query.mock.calls[0];
    expect(String(sql)).toContain("NOT (r.status = ANY($6::varchar[]))");
    expect(args).toEqual([
      USER,
      20001,
      null,
      null,
      null,
      ["ignored"],
      ["gmail.com"],
      ["%.gmail.com"],
      "2026-01-01",
      "2026-01-31",
      ...NO_SEARCH,
    ]);
  });

  it("a filter without status or domain binds nulls", async () => {
    const h = bulkSetup([locked(A)]);
    await h.service.bulk(USER, "ignore", { filter: {} }, 1);
    expect(h.manager.query.mock.calls[0][1]).toEqual([
      USER,
      20001,
      null,
      null,
      null,
      [],
      [],
      [],
      null,
      null,
      ...NO_SEARCH,
    ]);
  });

  it("refuses a different count with 409 and the current count, before any write", async () => {
    const h = bulkSetup([locked(A), locked(B), locked(C)]);
    const error = await h.service
      .bulk(USER, "delete", { filter: { domain: "gmail.com" } }, 5)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      errorCode: "EMAIL_RECEIPTS_BULK_COUNT_CHANGED",
      currentCount: 3,
    });
    expect(writes(h)).toEqual([]);
    expect(statements(h)).toHaveLength(1);
  });

  it("refuses a smaller count too, writing nothing", async () => {
    const h = bulkSetup([locked(A), locked(B), locked(C)]);
    await expect(
      h.service.bulk(USER, "ignore", { ids: [A, B, C] }, 2),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes(h)).toEqual([]);
  });

  it("refuses a filter that matches more than 20,000 emails with a 400, writing nothing", async () => {
    const many = Array.from({ length: 20001 }, (_, i) => locked(`id-${i}`));
    const h = bulkSetup(many);
    await expect(
      h.service.bulk(USER, "delete", { filter: {} }, 20000),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes(h)).toEqual([]);
  });

  it("accepts exactly 20,000 matching emails", async () => {
    const many = Array.from({ length: 20000 }, (_, i) => locked(`id-${i}`));
    const h = bulkSetup(many);
    const out = await h.service.bulk(USER, "delete", { filter: {} }, 20000);
    expect(out.affected).toBe(20000);
  });

  it("refuses more than 500 ids without touching the database", async () => {
    const h = bulkSetup([]);
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      h.service.bulk(USER, "delete", { ids }, 501),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.manager.query).not.toHaveBeenCalled();
  });

  it("skips and counts emails linked to a transaction on delete", async () => {
    const h = bulkSetup([
      locked(A),
      locked(B, { transaction_id: "t1", status: "review" }),
      locked(C, { transaction_id: "t2", status: "review" }),
    ]);
    const out = await h.service.bulk(USER, "delete", { ids: [A, B, C] }, 3);
    expect(out).toEqual({
      affected: 1,
      skippedLinked: 2,
      unchanged: 0,
      notIgnorable: 0,
    });
    const del = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("DELETE FROM email_receipts"),
    );
    expect(del?.[1]).toEqual([[A], USER]);
    expect(String(del?.[0])).toContain("transaction_id IS NULL");
  });

  it("writes nothing when every email is linked", async () => {
    const h = bulkSetup([locked(A, { transaction_id: "t1" })]);
    const out = await h.service.bulk(USER, "delete", { ids: [A] }, 1);
    expect(out.skippedLinked).toBe(1);
    expect(out.affected).toBe(0);
    expect(writes(h)).toEqual([]);
  });

  it("ignore follows ignore(): ignored is unchanged, skipped and applied are not ignorable, linked is skipped", async () => {
    const h = bulkSetup([
      locked(A),
      locked(B, { status: "ignored" }),
      locked(C, { status: "skipped" }),
      locked(D, { status: "review", request_status: "applied" }),
      locked(E, { status: "review", transaction_id: "t1" }),
    ]);
    const out = await h.service.bulk(
      USER,
      "ignore",
      { ids: [A, B, C, D, E] },
      5,
    );
    expect(out).toEqual({
      affected: 1,
      skippedLinked: 1,
      unchanged: 1,
      notIgnorable: 2,
    });
    const update = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'ignored'"),
    );
    expect(update?.[1]).toEqual([[A], USER]);
    const close = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE ai_review_requests"),
    );
    expect(close?.[1]).toEqual([USER, [A]]);
    // An ignored settlement keeps no link rows (linked receipts spec 5).
    const links = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM email_receipt_links"),
    );
    expect(links?.[1]).toEqual([[A], USER]);
  });

  it("an ignore that has nothing to ignore closes and writes nothing", async () => {
    const h = bulkSetup([locked(A, { status: "ignored" })]);
    const out = await h.service.bulk(USER, "ignore", { ids: [A] }, 1);
    expect(out).toEqual({
      affected: 0,
      skippedLinked: 0,
      unchanged: 1,
      notIgnorable: 0,
    });
    expect(writes(h)).toEqual([]);
  });

  it("delete does not apply the ignore rules: an ignored or skipped email is deleted", async () => {
    const h = bulkSetup([
      locked(A, { status: "ignored" }),
      locked(B, { status: "skipped" }),
    ]);
    const out = await h.service.bulk(USER, "delete", { ids: [A, B] }, 2);
    expect(out.affected).toBe(2);
    expect(out.unchanged).toBe(0);
    expect(out.notIgnorable).toBe(0);
  });

  it("runs in one transaction", async () => {
    const h = bulkSetup([locked(A)]);
    await h.service.bulk(USER, "delete", { ids: [A] }, 1);
    // Lock, close, the link rows (a component loses its reason first), delete.
    expect(h.manager.query.mock.calls.length).toBe(4);
  });

  it("deletes the link rows of deleted settlements before the receipts", async () => {
    const h = bulkSetup([locked(A)]);
    await h.service.bulk(USER, "delete", { ids: [A] }, 1);
    const sqls = h.manager.query.mock.calls.map(([sql]) => String(sql));
    const links = sqls.findIndex((s) =>
      s.includes("DELETE FROM email_receipt_links"),
    );
    const receipts = sqls.findIndex((s) =>
      s.includes("DELETE FROM email_receipts"),
    );
    expect(links).toBeGreaterThanOrEqual(0);
    expect(links).toBeLessThan(receipts);
  });
});

describe("EmailReceiptsService.countSelection", () => {
  it("counts through the selection predicate, capped one past the bulk limit", async () => {
    const h = setup();
    h.manager.query.mockResolvedValue([{ count: "7" }]);
    const out = await h.service.countSelection(USER, {
      status: "review",
      excludeDomains: ["gmail.com"],
      receivedFrom: "2026-01-01",
    });
    expect(out).toEqual({ count: 7 });
    const [sql, args] = h.manager.query.mock.calls[0];
    expect(String(sql)).toContain("user_id = $1");
    expect(String(sql)).toContain("LIMIT $2");
    expect(args).toEqual([
      USER,
      20001,
      "review",
      null,
      null,
      [],
      ["gmail.com"],
      ["%.gmail.com"],
      "2026-01-01",
      null,
      ...NO_SEARCH,
    ]);
  });

  it("counts zero when the database answers nothing", async () => {
    const h = setup();
    h.manager.query.mockResolvedValue([]);
    await expect(h.service.countSelection(USER, {})).resolves.toEqual({
      count: 0,
    });
  });
});

describe("EmailReceiptsService.reprocessSelection", () => {
  const SINCE = "2026-10-04T12:00:00.123456Z";
  const A = "11111111-1111-4111-8111-111111111111";

  function run(ids: string[], remaining = 0) {
    const h = setup();
    h.manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("AS since")) return [{ since: SINCE }];
      if (text.includes("SELECT r.id")) return ids.map((id) => ({ id }));
      if (text.includes("COUNT(*)::int AS remaining")) return [{ remaining }];
      return [];
    });
    return h;
  }
  const result = (status: string, over: Record<string, unknown> = {}) => ({
    status,
    statusReason: null,
    transactionId: null,
    matchKind: null,
    requestId: null,
    autoApplied: false,
    unchanged: false,
    ...over,
  });
  const select = (h: ReturnType<typeof setup>) =>
    h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT r.id"),
    ) as [string, unknown[]];

  it("runs the chunk oldest first, counts outcomes and answers remaining and since", async () => {
    const h = run(["a", "b"], 5);
    h.pipeline.process
      .mockResolvedValueOnce(result("review") as never)
      .mockResolvedValueOnce(result("unmatched") as never);
    const out = await h.service.reprocessSelection(USER, { filter: {} });
    expect(out).toEqual({
      processed: 2,
      byOutcome: { review: 1, unmatched: 1 },
      deleted: 0,
      failed: 0,
      remaining: 5,
      since: SINCE,
    });
    const [sql, args] = select(h);
    expect(String(sql)).toContain("ORDER BY r.received_at ASC, r.id ASC");
    expect(String(sql)).toContain("r.status NOT IN ('skipped', 'pending')");
    expect(String(sql)).toContain("rq.status IS DISTINCT FROM 'applied'");
    expect(String(sql)).toContain("r.updated_at < $3::timestamptz");
    // user, onlyStatuses, since, the eight selection values, limit
    expect(args.slice(0, 3)).toEqual([USER, [], SINCE]);
    expect(args[args.length - 1]).toBe(10);
  });

  it("counts an email its profile deletes as processed and deleted, under no status, and does not touch it", async () => {
    const h = run(["a", "b"]);
    h.pipeline.process
      .mockResolvedValueOnce(result("ignored", { deleted: true }) as never)
      .mockResolvedValueOnce(result("review") as never);
    const out = await h.service.reprocessSelection(USER, { filter: {} });
    expect(out).toMatchObject({
      processed: 2,
      byOutcome: { review: 1 },
      deleted: 1,
      failed: 0,
    });
    expect(
      h.manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("SET status_reason = status_reason"),
      ),
    ).toBe(false);
  });

  it("sends the caller's since back to the database clock and reads remaining with the same since", async () => {
    const h = run([], 0);
    await h.service.reprocessSelection(
      USER,
      { ids: [A] },
      { since: "2026-10-01T00:00:00Z" },
    );
    const sinceCall = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("AS since"),
    );
    expect(sinceCall?.[1]).toEqual(["2026-10-01T00:00:00Z"]);
    const left = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("COUNT(*)::int AS remaining"),
    );
    expect(left?.[1]).toEqual([USER, [], SINCE, [A]]);
    expect(String(left?.[0])).toContain("r.id = ANY($4::uuid[])");
  });

  it.each([
    [undefined, 10],
    [0, 1],
    [3, 3],
    [25, 25],
    [1000, 25],
  ])("limit %p runs at most %i", async (limit, expected) => {
    const h = run([]);
    await h.service.reprocessSelection(USER, { filter: {} }, { limit });
    const args = select(h)[1];
    expect(args[args.length - 1]).toBe(expected);
  });

  it("guards by onlyStatuses and shares one AI budget", async () => {
    const h = run(["a", "b"]);
    h.pipeline.process.mockResolvedValue(result("review") as never);
    await h.service.reprocessSelection(
      USER,
      { filter: {} },
      { onlyStatuses: ["ignored"] },
    );
    expect(select(h)[1][1]).toEqual(["ignored"]);
    const [first, second] = h.pipeline.process.mock.calls;
    expect(first[2]).toMatchObject({ onlyWhenStatusIn: ["ignored"] });
    expect(first[2]?.aiCategoryBudget).toBe(second[2]?.aiCategoryBudget);
    expect(first[2]?.aiCategoryBudget?.remaining).toBe(
      EMAIL_RECEIPTS_BATCH_AI_CATEGORY_CALLS,
    );
  });

  it("runs the row action's reprocess when onlyStatuses is absent or empty", async () => {
    const h = run(["a"]);
    h.pipeline.process.mockResolvedValue(result("review") as never);
    await h.service.reprocessSelection(USER, { filter: {} });
    await h.service.reprocessSelection(
      USER,
      { filter: {} },
      { onlyStatuses: [] },
    );
    for (const call of h.pipeline.process.mock.calls) {
      expect(call[2]).not.toHaveProperty("onlyWhenStatusIn");
    }
  });

  it("does not count an email left alone, and touches it so the run does not take it again", async () => {
    const h = run(["a", "b"]);
    h.pipeline.process
      .mockResolvedValueOnce(result("review", { unchanged: true }) as never)
      .mockResolvedValueOnce(result("review") as never);
    const out = await h.service.reprocessSelection(
      USER,
      { filter: {} },
      { onlyStatuses: ["review"] },
    );
    expect(out.processed).toBe(1);
    const touch = h.manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET status_reason = status_reason"),
    );
    expect(touch.map((c) => c[1])).toEqual([["a", USER]]);
  });

  it("counts a failed email, touches it and goes on", async () => {
    const h = run(["a", "b"]);
    h.pipeline.process
      .mockRejectedValueOnce(new ConflictException("applied"))
      .mockResolvedValueOnce(result("review") as never);
    const out = await h.service.reprocessSelection(USER, { filter: {} });
    expect(out).toMatchObject({ processed: 1, failed: 1 });
    const touch = h.manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status_reason = status_reason"),
    );
    expect(touch?.[1]).toEqual(["a", USER]);
  });

  it("refuses more than 500 ids before reading anything", async () => {
    const h = run([]);
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      h.service.reprocessSelection(USER, { ids }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.manager.query).not.toHaveBeenCalled();
    expect(h.pipeline.process).not.toHaveBeenCalled();
  });

  it("an empty selection is a quiet answer", async () => {
    const h = run([]);
    const out = await h.service.reprocessSelection(USER, { filter: {} });
    expect(h.pipeline.process).not.toHaveBeenCalled();
    expect(out).toEqual({
      processed: 0,
      byOutcome: {},
      deleted: 0,
      failed: 0,
      remaining: 0,
      since: SINCE,
    });
  });
});

describe("EmailReceiptsService.approvableSelection", () => {
  const A = "11111111-1111-4111-8111-111111111111";

  function approvable(requestIds: string[], trades = 0) {
    const h = setup();
    h.manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("COUNT(*)::int AS trades")) return [{ trades }];
      return requestIds.map((request_id) => ({ request_id }));
    });
    return h;
  }

  it("returns the proposed non-trade requests and counts the trades left out", async () => {
    const h = approvable(["rq1", "rq2"], 3);
    const out = await h.service.approvableSelection(USER, { ids: [A] });
    expect(out).toEqual({ requestIds: ["rq1", "rq2"], trades: 3 });
    const [list, count] = h.manager.query.mock.calls.map(([sql]) =>
      String(sql),
    );
    for (const sql of [list, count]) {
      expect(sql).toContain("r.status = 'review'");
      expect(sql).toContain("rq.status = 'proposed'");
      expect(sql).toContain("rq.expires_at > CURRENT_TIMESTAMP");
      expect(sql).toContain("r.id = ANY($2::uuid[])");
    }
    expect(list).toContain(
      "AND NOT (r.trade IS NOT NULL OR rq.kind = 'email_trade')",
    );
    expect(count).toContain(
      "AND (r.trade IS NOT NULL OR rq.kind = 'email_trade')",
    );
    expect(h.manager.query.mock.calls[0][1]).toEqual([USER, [A], 2001]);
  });

  it("reads a filter through the selection predicate", async () => {
    const h = approvable([]);
    await h.service.approvableSelection(USER, {
      filter: { excludeStatuses: ["ignored"] },
    });
    const args = h.manager.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe(USER);
    expect(args).toContainEqual(["ignored"]);
    expect(args[args.length - 1]).toBe(2001);
  });

  it("accepts exactly 2,000 proposals", async () => {
    const h = approvable(Array.from({ length: 2000 }, (_, i) => `rq${i}`));
    const out = await h.service.approvableSelection(USER, { filter: {} });
    expect(out.requestIds).toHaveLength(2000);
  });

  it("refuses more than 2,000 proposals with a 400 before counting trades", async () => {
    const h = approvable(Array.from({ length: 2001 }, (_, i) => `rq${i}`));
    await expect(
      h.service.approvableSelection(USER, { filter: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.manager.query).toHaveBeenCalledTimes(1);
  });

  it("refuses more than 500 ids without touching the database", async () => {
    const h = approvable([]);
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      h.service.approvableSelection(USER, { ids }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.manager.query).not.toHaveBeenCalled();
  });
});
