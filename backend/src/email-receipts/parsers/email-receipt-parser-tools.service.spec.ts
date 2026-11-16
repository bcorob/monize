import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
  WEALTHSIMPLE_TFSA_ACCOUNT_ID,
  WEALTHSIMPLE_TRADE_DEFINITION,
} from "../parsing/fixtures/wealthsimple-trade";
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
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Account } from "../../accounts/entities/account.entity";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE } from "./parser-tool.guide";
import { MAX_PARSERS_PER_USER } from "./email-receipt-parsers.service";
import {
  EmailReceiptParserToolsService,
  PARSER_TOOL_MAX_CATEGORIES,
} from "./email-receipt-parser-tools.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const R1 = "30000000-0000-4000-8000-000000000001";
const R2 = "30000000-0000-4000-8000-000000000002";
const REQ = "30000000-0000-4000-8000-000000000009";
const CAT_BOOKS = "11111111-1111-4111-8111-111111111111";
const CAT_SHIP = "22222222-2222-4222-8222-222222222222";
const CAT_GONE = "33333333-3333-4333-8333-333333333333";
const CALLER = "assistant";

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
  shippingCategoryId: CAT_SHIP,
};

const receipt = (over: Partial<EmailReceipt> = {}) =>
  Object.assign(new EmailReceipt(), {
    id: R1,
    userId: USER,
    subject: "Your order ABCD1234",
    bodyText: [
      "Order number: ABCD1234",
      "Items",
      "Widget 12.00",
      "Subtotal 12.00",
      "Shipping: 3.00",
      "Order total: 15.00",
    ].join("\n"),
    receivedAt: new Date("2026-09-10T10:00:00Z"),
    originalSentAt: null,
    ...over,
  });

function setup() {
  const parserRepo = {
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findOneByOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((v: Partial<EmailReceiptParser>) =>
      Object.assign(new EmailReceiptParser(), v),
    ),
    save: jest.fn(async (v: EmailReceiptParser) =>
      Object.assign(v, { id: "p-new", fromDomains: v.fromDomains }),
    ),
  };
  const receiptRepo = { find: jest.fn().mockResolvedValue([receipt()]) };
  const categoryRepo = {
    find: jest.fn().mockResolvedValue([
      { id: CAT_BOOKS, name: "Books", parentId: null },
      { id: CAT_SHIP, name: "Shipping", parentId: null },
    ]),
    count: jest.fn(async ({ where }) => (where.id._value as string[]).length),
  };
  const payeeRepo = {
    count: jest.fn().mockResolvedValue(1),
    findOne: jest.fn().mockResolvedValue(null),
  };
  // The open brokerage accounts a trade profile may name (`usableTradeAccountIds`).
  const accountRepo = {
    find: jest.fn(async ({ where }) =>
      (where.id._value as string[])
        .filter(
          (id) =>
            id === WEALTHSIMPLE_RRSP_ACCOUNT_ID ||
            id === WEALTHSIMPLE_TFSA_ACCOUNT_ID,
        )
        .map((id) => ({ id, accountSubType: "INVESTMENT_BROKERAGE" })),
    ),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceiptParser, parserRepo],
    [EmailReceipt, receiptRepo],
    [Category, categoryRepo],
    [Payee, payeeRepo],
    [Account, accountRepo],
  ]);
  // The candidate query (`JOIN accounts`) the test's matching runs; none by default.
  manager.query.mockResolvedValue([]);
  const payees = {
    resolveByName: jest.fn().mockResolvedValue(null),
  };
  const requests = {
    proposeParserDraft: jest.fn().mockResolvedValue(true),
  };
  const service = new EmailReceiptParserToolsService(
    dataSource as never,
    payees as never,
    requests as never,
  );
  /** The request row `lockClaimedRequest` reads, when a spec gives a requestId. */
  const requestRow = (over: Record<string, unknown> = {}) =>
    manager.query.mockResolvedValue([
      {
        kind: "email_parser_draft",
        status: "claimed",
        claimed_by: CALLER,
        live: true,
        parser_domain: "shop.example.com",
        proposal: null,
        domains: ["shop.example.com"],
        ...over,
      },
    ]);
  return {
    service,
    manager,
    parserRepo,
    receiptRepo,
    categoryRepo,
    payeeRepo,
    payees,
    requests,
    requestRow,
  };
}

describe("EmailReceiptParserToolsService.listCategories", () => {
  it("lists the user's categories as id and qualified name", async () => {
    const { service } = setup();

    await expect(service.listCategories(USER)).resolves.toEqual({
      categories: [
        { id: CAT_BOOKS, name: "Books" },
        { id: CAT_SHIP, name: "Shipping" },
      ],
      totalCount: 2,
      truncated: false,
      investmentAccounts: [],
      guide: EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE,
    });
  });

  it("lists the user's open investment accounts, cash accounts apart, for a trade profile's account rules", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { id: "acc-1", name: "RRSP", currencyCode: "CAD" },
      { id: "acc-2", name: "RRSP USD", currencyCode: "USD" },
    ]);

    const result = await service.listCategories(USER);

    // The currency lets an agent write one rule per currency for accounts the
    // broker prints alike.
    expect(result.investmentAccounts).toEqual([
      { id: "acc-1", name: "RRSP", currencyCode: "CAD" },
      { id: "acc-2", name: "RRSP USD", currencyCode: "USD" },
    ]);
    const [sql, params] = manager.query.mock.calls[0];
    expect(String(sql)).toContain('currency_code AS "currencyCode"');
    expect(String(sql)).toContain("account_type = 'INVESTMENT'");
    expect(String(sql)).toContain("IS DISTINCT FROM 'INVESTMENT_CASH'");
    expect(String(sql)).toContain("is_closed = false");
    expect(params).toEqual([USER]);
  });

  it("is bounded, and says when more exist", async () => {
    const { service, categoryRepo } = setup();
    categoryRepo.find.mockResolvedValue(
      Array.from({ length: PARSER_TOOL_MAX_CATEGORIES + 20 }, (_, i) => ({
        id: `c${i}`,
        name: `Category ${i}`,
        parentId: null,
      })),
    );

    const result = await service.listCategories(USER);

    expect(result.categories).toHaveLength(PARSER_TOOL_MAX_CATEGORIES);
    expect(result.totalCount).toBe(PARSER_TOOL_MAX_CATEGORIES + 20);
    expect(result.truncated).toBe(true);
  });

  it("reads only the user's own categories", async () => {
    const { service, categoryRepo } = setup();

    await service.listCategories(USER);

    expect(categoryRepo.find.mock.calls[0][0].where.userId).toBe(USER);
  });

  it("returns the whole parser language beside the categories", async () => {
    const { service } = setup();

    const result = await service.listCategories(USER);

    expect(result.guide).toBe(EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE);
    expect(result.guide).toContain("joinWrapped");
  });
});

describe("EmailReceiptParserToolsService.listParsers and getParser", () => {
  const PARSER_ID = "50000000-0000-4000-8000-000000000001";
  const stored = (over: Partial<EmailReceiptParser> = {}) =>
    Object.assign(new EmailReceiptParser(), {
      id: PARSER_ID,
      userId: USER,
      name: "Example Shop",
      payeeId: null,
      fromDomains: ["shop.example.com"],
      subjectContains: ["order"],
      definition: { ...DEFINITION, match: undefined },
      status: "approved",
      source: "manual",
      approvedAt: new Date("2026-09-02T10:00:00Z"),
      revision: 3,
      createdAt: new Date("2026-09-01T10:00:00Z"),
      updatedAt: new Date("2026-09-03T10:00:00Z"),
      ...over,
    });

  it("lists the user's parsers, newest change first, bounded, as summaries without the definition", async () => {
    const { service, parserRepo } = setup();
    parserRepo.find.mockResolvedValue([
      stored(),
      stored({ id: "p-2", status: "draft", source: "ai", definition: {} }),
    ]);

    const result = await service.listParsers(USER);

    expect(parserRepo.find).toHaveBeenCalledWith({
      where: { userId: USER },
      order: { updatedAt: "DESC", id: "DESC" },
      take: MAX_PARSERS_PER_USER,
    });
    expect(result).toEqual([
      {
        id: PARSER_ID,
        name: "Example Shop",
        fromDomains: ["shop.example.com"],
        subjectContains: ["order"],
        status: "approved",
        source: "manual",
        revision: 3,
        definitionValid: true,
        updatedAt: "2026-09-03T10:00:00.000Z",
      },
      expect.objectContaining({
        id: "p-2",
        status: "draft",
        source: "ai",
        definitionValid: false,
      }),
    ]);
    expect(result[0]).not.toHaveProperty("definition");
  });

  it.each(["approved", "draft"] as const)(
    "reads one %s parser in full with category names and the payee's name",
    async (status) => {
      const { service, parserRepo, payeeRepo } = setup();
      parserRepo.findOne.mockResolvedValue(
        stored({ status, payeeId: "payee-1" }),
      );
      payeeRepo.findOne.mockResolvedValue({ name: "Example Shop Ltd" });

      const result = await service.getParser(USER, PARSER_ID);

      expect(parserRepo.findOne).toHaveBeenCalledWith({
        where: { id: PARSER_ID, userId: USER },
      });
      expect(payeeRepo.findOne).toHaveBeenCalledWith({
        where: { id: "payee-1", userId: USER },
        select: { name: true },
      });
      expect(result).toMatchObject({
        id: PARSER_ID,
        status,
        revision: 3,
        payeeId: "payee-1",
        payeeName: "Example Shop Ltd",
        definitionValid: true,
      });
      expect(result).not.toHaveProperty("reprocessableCount");
      expect(result.definition).toMatchObject({
        defaultCategory: "Books",
        shippingCategory: "Shipping",
      });
      expect(result.definition).not.toHaveProperty("defaultCategoryId");
    },
  );

  it("gives a null payeeName for a parser with no payee, without reading payees", async () => {
    const { service, parserRepo, payeeRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());

    await expect(service.getParser(USER, PARSER_ID)).resolves.toMatchObject({
      payeeName: null,
    });
    expect(payeeRepo.findOne).not.toHaveBeenCalled();
  });

  it("refuses a parser that is missing or not the user's with a 404", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(null);

    await expect(service.getParser(USER, PARSER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(parserRepo.findOne).toHaveBeenCalledWith({
      where: { id: PARSER_ID, userId: USER },
    });
  });

  it("refuses a malformed id as not found, without a query", async () => {
    const { service, parserRepo } = setup();

    await expect(service.getParser(USER, "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(parserRepo.findOne).not.toHaveBeenCalled();
  });

  it("returns a definition that passes testDefinition and saveDraft unchanged, as a new draft", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    const { definition } = await service.getParser(USER, PARSER_ID);

    const tested = await service.testDefinition(USER, {
      definition,
      receiptIds: [R1],
    });
    expect(tested).toMatchObject({ valid: true, unknownCategoryIds: [] });

    parserRepo.findOne.mockClear();
    const saved = await service.saveDraft(USER, CALLER, {
      name: "Example Shop v2",
      fromDomains: ["shop.example.com"],
      definition,
    });
    expect(saved).toMatchObject({ parserId: "p-new", status: "draft" });
    expect(parserRepo.save).toHaveBeenCalledTimes(1);
    expect(parserRepo.update).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptParserToolsService.testDefinition", () => {
  it("reads each email and reports what it parsed in decimals, with category names", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt(),
      receipt({ id: R2, subject: "Another", bodyText: "nothing here" }),
    ]);

    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R2, R1],
    });

    expect(result.valid).toBe(true);
    expect(result.emails.map((e) => e.receiptId)).toEqual([R2, R1]);
    expect(result.emails[1].parsed).toEqual({
      orderId: "ABCD1234",
      reference: null,
      total: 15,
      paid: null,
      payee: null,
      shipping: 3,
      discount: null,
      items: [{ name: "Widget", qty: 1, amount: 12, category: "Books" }],
      complete: true,
      reason: null,
    });
    expect(result.emails[0].parsed).toMatchObject({
      total: null,
      complete: false,
      reason: "no_total",
    });
    expect(result.allComplete).toBe(false);
    expect(result.unknownCategoryIds).toEqual([]);
  });

  it("says which entry and which line read each value, and what the guards would do", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([receipt()]);

    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });

    const [email] = result.emails;
    expect(email.outcome).toBe("read");
    expect(email.trace.orderId).toMatchObject({
      entry: 0,
      pattern: "Order number: {orderid}",
      line: { line: 1, text: "Order number: ABCD1234" },
    });
    expect(email.trace.total).toMatchObject({ entry: 0, line: { line: 6 } });
    expect(email.trace.items).toEqual([
      expect.objectContaining({
        mode: "patterns",
        patterns: ["{name} {amount}"],
        lines: [{ line: 3, text: "Widget 12.00" }],
      }),
    ]);
  });

  it("reports a guard that would stop the pipeline reading the email", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([receipt()]);

    const result = await service.testDefinition(USER, {
      definition: { ...DEFINITION, requireLine: ["*PayU*"] },
      receiptIds: [R1],
    });

    expect(result.emails[0].outcome).toBe("not_applicable");
    expect(result.emails[0].trace.requireLine).toBeNull();
  });

  it("reads the lines of the definition's source: html lines for source html, the text otherwise", async () => {
    const { service, receiptRepo } = setup();
    const html =
      "<table><tr><td>Order number:</td><td>HTML-1</td></tr>" +
      "<tr><td>Wrapped product name</td><td>12.00</td></tr>" +
      "<tr><td>Order total:</td><td>12.00</td></tr></table>";
    receiptRepo.find.mockResolvedValue([receipt({ bodyHtml: html })]);
    const htmlDefinition = {
      version: 2,
      source: "html",
      orderId: [{ label: "Order number:", value: "{orderid}" }],
      total: [{ label: "Order total:", value: "{amount}" }],
      items: { patterns: ["{name} {amount}"] },
      defaultCategoryId: CAT_BOOKS,
    };

    const html1 = await service.testDefinition(USER, {
      definition: htmlDefinition,
      receiptIds: [R1],
    });
    const [email] = html1.emails;
    expect(email.outcome).toBe("read");
    expect(email.parsed).toMatchObject({ orderId: "HTML-1", total: 12 });
    expect(email.trace.total?.line).toEqual({ line: 6, text: "12.00" });

    // The same email read as text: the definition's own source decides.
    const text = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });
    expect(text.emails[0].parsed).toMatchObject({
      orderId: "ABCD1234",
      total: 15,
    });
  });

  it("an html parser on an email with no HTML part is outcome no_html and not complete", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([receipt({ bodyHtml: null })]);
    const result = await service.testDefinition(USER, {
      definition: { ...DEFINITION, source: "html" },
      receiptIds: [R1],
    });
    expect(result.emails[0].outcome).toBe("no_html");
    expect(result.emails[0].parsed).toMatchObject({
      total: null,
      complete: false,
      reason: "no_total",
    });
    expect(result.allComplete).toBe(false);
  });

  it("asks the store for the HTML part, which the test reads for an html parser", async () => {
    const { service, receiptRepo } = setup();
    await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });
    expect(receiptRepo.find.mock.calls[0][0].select).toMatchObject({
      bodyText: true,
      bodyHtml: true,
    });
  });

  it("refuses an unknown source as an invalid definition, reading no email", async () => {
    const { service, receiptRepo } = setup();
    const result = await service.testDefinition(USER, {
      definition: { ...DEFINITION, source: "pdf" },
      receiptIds: [R1],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ path: "source", code: "invalid_value" }]);
    expect(receiptRepo.find).not.toHaveBeenCalled();
  });

  it("traces at most 20 items per email", async () => {
    const { service, receiptRepo } = setup();
    const body = [
      "Items",
      ...Array.from({ length: 30 }, (_, i) => `P${i} 1.00`),
    ].join("\n");
    receiptRepo.find.mockResolvedValue([receipt({ bodyText: body })]);

    const result = await service.testDefinition(USER, {
      definition: {
        version: 2,
        items: { patterns: ["{name} {amount}"], startAfter: "Items" },
      },
      receiptIds: [R1],
    });

    expect(result.emails[0].parsed.items).toHaveLength(30);
    expect(result.emails[0].trace.items).toHaveLength(20);
  });

  it("is allComplete only when every email reads complete", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([receipt(), receipt({ id: R2 })]);

    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1, R2],
    });

    expect(result.allComplete).toBe(true);
  });

  it("accepts a definition with the version left out", async () => {
    const { service } = setup();
    const { version: _omit, ...unversioned } = DEFINITION;

    const result = await service.testDefinition(USER, {
      definition: unversioned,
      receiptIds: [R1],
    });

    expect(result.valid).toBe(true);
  });

  it("returns an invalid definition as a result with every error, reading no email", async () => {
    const { service, receiptRepo } = setup();

    const result = await service.testDefinition(USER, {
      definition: { total: ["no capture"], bogus: 1 },
      receiptIds: [R1],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => `${e.path}:${e.code}`)).toEqual(
      expect.arrayContaining(["bogus:unknown_key", "total[0]:capture_missing"]),
    );
    expect(result.emails).toEqual([]);
    expect(result.allComplete).toBe(false);
    expect(receiptRepo.find).not.toHaveBeenCalled();
  });

  it("lists a category the definition names that is not the user's, and is then not allComplete", async () => {
    const { service } = setup();

    const result = await service.testDefinition(USER, {
      definition: { ...DEFINITION, defaultCategoryId: CAT_GONE },
      receiptIds: [R1],
    });

    expect(result.unknownCategoryIds).toEqual([CAT_GONE]);
    expect(result.allComplete).toBe(false);
  });

  it("is a 404 for an email that is not the user's, and reads through the user's own scope", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([receipt()]);

    await expect(
      service.testDefinition(USER, {
        definition: DEFINITION,
        receiptIds: [R1, R2],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(receiptRepo.find.mock.calls[0][0].where.userId).toBe(USER);
  });

  it.each([[[]], [Array.from({ length: 26 }, () => R1)]])(
    "refuses %j emails",
    async (receiptIds) => {
      const { service, receiptRepo } = setup();

      await expect(
        service.testDefinition(USER, { definition: DEFINITION, receiptIds }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(receiptRepo.find).not.toHaveBeenCalled();
    },
  );

  it("uses the payee's default category as the fallback, resolved by name and never created", async () => {
    const { service, payees, receiptRepo } = setup();
    payees.resolveByName.mockResolvedValue({
      id: "pay1",
      name: "Shop",
      defaultCategoryId: CAT_BOOKS,
    });
    receiptRepo.find.mockResolvedValue([receipt()]);
    const { defaultCategoryId: _drop, ...noDefault } = DEFINITION;

    const result = await service.testDefinition(USER, {
      definition: noDefault,
      receiptIds: [R1],
      payeeName: "Shop",
    });

    expect(payees.resolveByName).toHaveBeenCalledWith(USER, "Shop");
    expect(result.emails[0].parsed.items[0].category).toBe("Books");
  });

  it("writes nothing", async () => {
    const { service, parserRepo, manager } = setup();

    await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });

    expect(parserRepo.save).not.toHaveBeenCalled();
    // The only statement is the matcher's read-only candidate SELECT.
    for (const [sql] of manager.query.mock.calls) {
      expect(String(sql).trim()).toMatch(/^SELECT/);
    }
  });

  describe("what the definition's match section would do", () => {
    const CANDIDATE = {
      id: "tx-1",
      transaction_date: "2026-09-12",
      amount: "-15.0000",
      payee_id: null,
      payee_name: "Shop",
      description: "CARD PURCHASE ORDER ABCD1234",
      reference_number: null,
    };

    it("reports the strategy that matched, the transaction and what each strategy kept", async () => {
      const { service, manager } = setup();
      manager.query.mockResolvedValue([CANDIDATE]);

      const result = await service.testDefinition(USER, {
        definition: {
          ...DEFINITION,
          match: { by: ["orderId", "amount_date"] },
        },
        receiptIds: [R1],
      });

      expect(result.emails[0].match).toEqual({
        outcome: "matched",
        strategy: "orderId",
        transaction: {
          id: "tx-1",
          date: "2026-09-12",
          amount: -15,
          payeeName: "Shop",
        },
        considered: 1,
        attempts: [{ strategy: "orderId", count: 1 }],
      });
    });

    it("loads candidates for the profile's window, not the default one", async () => {
      const { service, manager } = setup();

      await service.testDefinition(USER, {
        definition: {
          ...DEFINITION,
          match: { by: ["amount_date"], daysBefore: 0, daysAfter: 30 },
        },
        receiptIds: [R1],
      });

      const params = manager.query.mock.calls[0][1] as unknown[];
      expect(params[1]).toBe("2026-09-10");
      expect(params[2]).toBe("2026-10-10");
    });

    it("is unmatched, with each strategy's count, when nothing fits", async () => {
      const { service } = setup();

      const result = await service.testDefinition(USER, {
        definition: DEFINITION,
        receiptIds: [R1],
      });

      expect(result.emails[0].match).toEqual({
        outcome: "unmatched",
        strategy: null,
        transaction: null,
        considered: 0,
        attempts: [
          { strategy: "orderId", count: 0 },
          { strategy: "amount_payee", count: 0 },
          { strategy: "amount_date", count: 0 },
        ],
      });
    });

    it("reads the profile's reference field", async () => {
      const { service } = setup();

      const result = await service.testDefinition(USER, {
        definition: {
          ...DEFINITION,
          reference: ["Order number: {reference}"],
          match: { by: ["reference"] },
        },
        receiptIds: [R1],
      });

      expect(result.emails[0].parsed.reference).toBe("ABCD1234");
    });
  });

  it("dates an email by the shop's day when a forward carried it", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt({ originalSentAt: new Date("2026-08-10T10:15:00Z") }),
    ]);

    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });

    expect(result.emails[0].effectiveDate).toBe("2026-08-10T10:15:00.000Z");
  });
});

describe("EmailReceiptParserToolsService.saveDraft", () => {
  const input = {
    name: "Example Shop",
    fromDomains: [
      "Shop.Example.com",
      "shop.example.com",
      "@mail.shop.example.com",
    ],
    subjectContains: ["Order", " order ", ""],
    definition: DEFINITION,
  };

  it("stores a DRAFT of source ai, never approved, with normalized domains and subject words", async () => {
    const { service, parserRepo } = setup();

    const result = await service.saveDraft(USER, CALLER, input);

    const saved = parserRepo.save.mock.calls[0][0] as EmailReceiptParser;
    expect(saved).toMatchObject({
      userId: USER,
      name: "Example Shop",
      status: "draft",
      source: "ai",
      approvedAt: null,
      payeeId: null,
      fromDomains: ["shop.example.com", "mail.shop.example.com"],
      subjectContains: ["order"],
    });
    expect(result).toMatchObject({
      parserId: "p-new",
      status: "draft",
      requestProposed: false,
      payee: null,
    });
    expect(result.match).toMatchObject({ by: expect.any(Array) });
  });

  it("reports no matching for a trade profile, which matches no bank transaction", async () => {
    const { service } = setup();

    const result = await service.saveDraft(USER, CALLER, {
      name: "Wealthsimple trades",
      fromDomains: ["wealthsimple.com"],
      definition: WEALTHSIMPLE_TRADE_DEFINITION,
    });

    expect(result.match).toBeNull();
  });

  it("validates the definition with the one validator, and writes nothing when it is refused", async () => {
    const { service, parserRepo, manager } = setup();

    const error = await service
      .saveDraft(USER, CALLER, {
        ...input,
        definition: { version: 2, total: ["no capture"], bogus: 1 },
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("bogus: unknown_key");
    expect(parserRepo.save).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("accepts a definition with the version left out", async () => {
    const { service, parserRepo } = setup();
    const { version: _omit, ...unversioned } = DEFINITION;

    await service.saveDraft(USER, CALLER, {
      ...input,
      definition: unversioned,
    });

    expect(
      (parserRepo.save.mock.calls[0][0] as EmailReceiptParser).definition,
    ).toMatchObject({ version: 2 });
  });

  it.each([
    ["no name", { name: "  " }],
    ["no domain", { fromDomains: [] }],
    ["a domain that is no host name", { fromDomains: ["not a domain"] }],
    ["a bare word", { fromDomains: ["localhost"] }],
  ])("refuses %s, writing nothing", async (_name, over) => {
    const { service, parserRepo } = setup();

    await expect(
      service.saveDraft(USER, CALLER, { ...input, ...over }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("resolves the payee by name, never creating one", async () => {
    const { service, payees, parserRepo } = setup();
    payees.resolveByName.mockResolvedValue({
      id: "pay1",
      name: "Example Shop",
    });

    const result = await service.saveDraft(USER, CALLER, {
      ...input,
      payeeName: "Example Shop",
    });

    expect(payees.resolveByName).toHaveBeenCalledWith(USER, "Example Shop");
    expect(
      (parserRepo.save.mock.calls[0][0] as EmailReceiptParser).payeeId,
    ).toBe("pay1");
    expect(result.payee).toEqual({ id: "pay1", name: "Example Shop" });
  });

  it("saves with no payee when the name resolves to none, and says so", async () => {
    const { service, payees, parserRepo } = setup();
    payees.resolveByName.mockResolvedValue(null);

    const result = await service.saveDraft(USER, CALLER, {
      ...input,
      payeeName: "Nobody",
    });

    expect(
      (parserRepo.save.mock.calls[0][0] as EmailReceiptParser).payeeId,
    ).toBeNull();
    expect(result.payee).toBeNull();
  });

  it("checks the user owns every category and the payee, in the write's transaction", async () => {
    const { service, categoryRepo, parserRepo, payees, payeeRepo } = setup();
    payees.resolveByName.mockResolvedValue({ id: "pay1", name: "Shop" });

    await service.saveDraft(USER, CALLER, { ...input, payeeName: "Shop" });

    expect(payeeRepo.count).toHaveBeenCalledWith({
      where: { id: "pay1", userId: USER },
    });
    expect(categoryRepo.count.mock.calls[0][0].where.userId).toBe(USER);
    expect(categoryRepo.count.mock.invocationCallOrder[0]).toBeLessThan(
      parserRepo.save.mock.invocationCallOrder[0],
    );
  });

  it("refuses a category that is not the user's, writing nothing", async () => {
    const { service, categoryRepo, parserRepo } = setup();
    categoryRepo.count.mockResolvedValue(0);

    await expect(service.saveDraft(USER, CALLER, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("refuses beyond the parser cap", async () => {
    const { service, parserRepo } = setup();
    parserRepo.count.mockResolvedValue(MAX_PARSERS_PER_USER);

    await expect(service.saveDraft(USER, CALLER, input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  describe("answering a parser draft request", () => {
    it("locks the request first, then writes the parser and proposes the request in the same transaction", async () => {
      const { service, manager, parserRepo, requests, requestRow } = setup();
      requestRow();

      const result = await service.saveDraft(USER, CALLER, {
        ...input,
        requestId: REQ,
      });

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toMatch(/FROM ai_review_requests/);
      expect(sql).toMatch(/FOR UPDATE/);
      expect(sql).toMatch(/user_id = \$2/);
      expect(params).toEqual([REQ, USER]);
      expect(requests.proposeParserDraft).toHaveBeenCalledWith(
        manager,
        USER,
        REQ,
        CALLER,
        "p-new",
      );
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        parserRepo.save.mock.invocationCallOrder[0],
      );
      expect(parserRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
        requests.proposeParserDraft.mock.invocationCallOrder[0],
      );
      expect(result.requestProposed).toBe(true);
    });

    it.each([
      ["another caller's claim", { claimed_by: "mcp-session" }],
      [
        "a pending request nobody claimed",
        { status: "pending", claimed_by: null },
      ],
      ["a request already proposed", { status: "proposed" }],
      ["a dismissed request", { status: "rejected" }],
      ["an expired request", { live: false }],
      ["a request of another kind", { kind: "email_receipt" }],
    ])("refuses %s with a 409, writing no parser", async (_name, over) => {
      const { service, parserRepo, requests, requestRow } = setup();
      requestRow(over);

      await expect(
        service.saveDraft(USER, CALLER, { ...input, requestId: REQ }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(parserRepo.save).not.toHaveBeenCalled();
      expect(requests.proposeParserDraft).not.toHaveBeenCalled();
    });

    it("is a 404 for a request that is not the user's", async () => {
      const { service, manager, parserRepo } = setup();
      manager.query.mockResolvedValue([]);

      await expect(
        service.saveDraft(USER, CALLER, { ...input, requestId: REQ }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(parserRepo.save).not.toHaveBeenCalled();
    });

    it("refuses, so the parser rolls back, when the conditional UPDATE matches nothing after the check", async () => {
      const { service, requests, requestRow } = setup();
      requestRow();
      requests.proposeParserDraft.mockResolvedValue(false);

      await expect(
        service.saveDraft(USER, CALLER, { ...input, requestId: REQ }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    describe("a draft already covers the request's sender", () => {
      const row = {
        kind: "email_parser_draft",
        status: "claimed",
        claimed_by: CALLER,
        live: true,
        parser_domain: "shop.example.com",
        proposal: null,
        domains: ["shop.example.com"],
      };
      const oldDraft = (over: Partial<EmailReceiptParser> = {}) =>
        Object.assign(new EmailReceiptParser(), {
          id: "p-old",
          userId: USER,
          status: "draft",
          revision: 2,
          fromDomains: ["shop.example.com"],
          ...over,
        });

      it("updates the newest such draft and bumps its revision instead of creating another", async () => {
        const { service, manager, parserRepo, requests } = setup();
        manager.query
          .mockResolvedValueOnce([row])
          .mockResolvedValueOnce([{ id: "p-old" }]);
        parserRepo.findOne.mockResolvedValue(oldDraft());
        parserRepo.findOneByOrFail.mockResolvedValue(
          oldDraft({ name: "Example Shop", revision: 3 }),
        );

        const result = await service.saveDraft(USER, CALLER, {
          ...input,
          requestId: REQ,
        });

        const [sql, params] = manager.query.mock.calls[1];
        expect(sql).toContain("p.status = 'draft'");
        expect(sql).toContain("p.user_id = $1");
        expect(sql).toContain("ORDER BY p.updated_at DESC, p.id DESC");
        expect(params).toEqual([USER, ["shop.example.com"], null]);
        expect(parserRepo.findOne).toHaveBeenCalledWith({
          where: { id: "p-old", userId: USER, status: "draft" },
          lock: { mode: "pessimistic_write" },
        });
        expect(parserRepo.save).not.toHaveBeenCalled();
        expect(parserRepo.update.mock.calls[0][1].revision()).toBe(
          "revision + 1",
        );
        expect(requests.proposeParserDraft).toHaveBeenCalledWith(
          manager,
          USER,
          REQ,
          CALLER,
          "p-old",
        );
        expect(result).toMatchObject({ parserId: "p-old", revision: 3 });
      });

      it("creates a draft when none covers the sender", async () => {
        const { service, manager, parserRepo } = setup();
        manager.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);

        const result = await service.saveDraft(USER, CALLER, {
          ...input,
          requestId: REQ,
        });

        expect(parserRepo.save).toHaveBeenCalledTimes(1);
        expect(parserRepo.update).not.toHaveBeenCalled();
        expect(result.parserId).toBe("p-new");
      });

      it("keeps an explicit parserId and its revision check over the lookup", async () => {
        const { service, manager, parserRepo } = setup();
        manager.query.mockResolvedValueOnce([row]);
        parserRepo.findOne.mockResolvedValue(oldDraft({ revision: 2 }));
        parserRepo.findOneByOrFail.mockResolvedValue(oldDraft({ revision: 3 }));

        await service.saveDraft(USER, CALLER, {
          ...input,
          requestId: REQ,
          parserId: "p-old",
          expectedRevision: 2,
        });

        expect(manager.query).toHaveBeenCalledTimes(1);
      });

      it("never reaches an approved parser (only drafts are looked up)", async () => {
        const { service, manager, parserRepo } = setup();
        manager.query
          .mockResolvedValueOnce([row])
          .mockResolvedValueOnce([{ id: "p-approved" }]);
        // the locked row is no longer a draft by the time it is read
        parserRepo.findOne.mockResolvedValue(null);

        await service.saveDraft(USER, CALLER, { ...input, requestId: REQ });

        expect(parserRepo.findOne.mock.calls[0][0].where.status).toBe("draft");
        expect(parserRepo.save).toHaveBeenCalledTimes(1);
      });
    });

    describe("a request that spans several sender domains", () => {
      const multi = (over: Record<string, unknown> = {}) => ({
        kind: "email_parser_draft",
        status: "proposed",
        claimed_by: CALLER,
        live: true,
        parser_domain: "shop.example.com",
        proposal: { parserId: "p-a", parserIds: ["p-a"] },
        domains: ["pay.example.com", "shop.example.com"],
        ...over,
      });
      const draftA = () =>
        Object.assign(new EmailReceiptParser(), {
          id: "p-a",
          userId: USER,
          status: "draft",
          revision: 1,
          fromDomains: ["shop.example.com"],
        });
      const payInput = { ...input, fromDomains: ["pay.example.com"] };

      it("accepts the second sender's draft while the request is proposed", async () => {
        const { service, manager, parserRepo, requests } = setup();
        manager.query.mockResolvedValueOnce([multi()]);
        parserRepo.find.mockResolvedValue([draftA()]);

        const result = await service.saveDraft(USER, CALLER, {
          ...payInput,
          requestId: REQ,
        });

        expect(parserRepo.save).toHaveBeenCalledTimes(1);
        expect(requests.proposeParserDraft).toHaveBeenCalledWith(
          manager,
          USER,
          REQ,
          CALLER,
          "p-new",
        );
        expect(result.requestProposed).toBe(true);
      });

      it("accepts the first draft while the request is claimed", async () => {
        const { service, manager, parserRepo } = setup();
        manager.query.mockResolvedValueOnce([
          multi({ status: "claimed", proposal: null }),
        ]);

        await service.saveDraft(USER, CALLER, {
          ...payInput,
          requestId: REQ,
        });

        expect(parserRepo.save).toHaveBeenCalledTimes(1);
        // the lookup is for the request's domain the draft covers
        expect(manager.query.mock.calls[1][1]).toEqual([
          USER,
          ["pay.example.com"],
          null,
        ]);
      });

      it("updates the listed draft that covers the domain instead of adding another", async () => {
        const { service, manager, parserRepo, requests } = setup();
        manager.query
          .mockResolvedValueOnce([multi()])
          .mockResolvedValueOnce([{ id: "p-a" }]);
        parserRepo.findOne.mockResolvedValue(draftA());
        parserRepo.findOneByOrFail.mockResolvedValue({
          ...draftA(),
          revision: 2,
        });

        const result = await service.saveDraft(USER, CALLER, {
          ...input,
          requestId: REQ,
        });

        // the first lookup is limited to the drafts the request lists
        expect(manager.query.mock.calls[1][1]).toEqual([
          USER,
          ["shop.example.com"],
          ["p-a"],
        ]);
        expect(parserRepo.save).not.toHaveBeenCalled();
        expect(requests.proposeParserDraft).toHaveBeenCalledWith(
          manager,
          USER,
          REQ,
          CALLER,
          "p-a",
        );
        expect(result).toMatchObject({ parserId: "p-a", revision: 2 });
      });

      it("refuses a draft that covers no domain of the request, writing nothing", async () => {
        const { service, manager, parserRepo, requests } = setup();
        manager.query.mockResolvedValueOnce([multi()]);
        parserRepo.find.mockResolvedValue([draftA()]);

        await expect(
          service.saveDraft(USER, CALLER, {
            ...input,
            fromDomains: ["third.example.com"],
            requestId: REQ,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(parserRepo.save).not.toHaveBeenCalled();
        expect(requests.proposeParserDraft).not.toHaveBeenCalled();
      });

      it("refuses a new draft for a domain a listed draft already covers", async () => {
        const { service, manager, parserRepo } = setup();
        // the listed draft cannot be found to update (it was approved meanwhile)
        manager.query.mockResolvedValueOnce([multi()]);
        parserRepo.find.mockResolvedValue([draftA()]);

        await expect(
          service.saveDraft(USER, CALLER, { ...input, requestId: REQ }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(parserRepo.save).not.toHaveBeenCalled();
      });

      it("still refuses a proposed request that spans one domain", async () => {
        const { service, manager, parserRepo } = setup();
        manager.query.mockResolvedValueOnce([
          multi({ domains: ["shop.example.com"] }),
        ]);

        await expect(
          service.saveDraft(USER, CALLER, {
            ...payInput,
            requestId: REQ,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(parserRepo.save).not.toHaveBeenCalled();
      });
    });

    it("never touches a request when none is named", async () => {
      const { service, manager, requests } = setup();

      await service.saveDraft(USER, CALLER, input);

      expect(manager.query).not.toHaveBeenCalled();
      expect(requests.proposeParserDraft).not.toHaveBeenCalled();
    });
  });
});

describe("EmailReceiptParserToolsService.testDefinition of a trade profile", () => {
  it("reports what the profile read as shares and decimal money, with no bank match, and counts a complete trade as complete", async () => {
    const { service, receiptRepo, manager } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt({ bodyText: WEALTHSIMPLE_BUY_BODY }),
    ]);

    const result = await service.testDefinition(USER, {
      definition: WEALTHSIMPLE_TRADE_DEFINITION,
      receiptIds: [R1],
    });

    expect(result.valid).toBe(true);
    const [email] = result.emails;
    expect(email.trade?.parsed).toEqual({
      action: "BUY",
      symbol: "XCNS",
      quantity: 75.9878,
      total: 2000,
      price: 26.32,
      commission: null,
      currency: null,
      currencySource: null,
      date: "2026-10-15",
      accountText: "RRSP",
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      complete: true,
      consistent: true,
      reason: null,
    });
    expect(email.trade?.trace.symbol?.line.text).toBe("Symbol: XCNS");
    expect(email.outcome).toBe("read");
    expect(email.match.outcome).toBe("unmatched");
    expect(result.allComplete).toBe(true);
    // No candidate query: a trade creates a transaction, it does not find one.
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("is not complete when the trade is not", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt({
        bodyText: WEALTHSIMPLE_BUY_BODY.replace("Symbol:", "Ticker:"),
      }),
    ]);
    const result = await service.testDefinition(USER, {
      definition: WEALTHSIMPLE_TRADE_DEFINITION,
      receiptIds: [R1],
    });
    expect(result.emails[0].trade?.parsed.reason).toBe("trade_no_symbol");
    expect(result.allComplete).toBe(false);
  });

  it("lists an account id that is not an open brokerage account of the user's, and is then not complete", async () => {
    const { service, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt({ bodyText: WEALTHSIMPLE_BUY_BODY }),
    ]);
    const made_up = "90000000-0000-4000-8000-000000000009";
    const result = await service.testDefinition(USER, {
      definition: {
        ...WEALTHSIMPLE_TRADE_DEFINITION,
        trade: {
          ...WEALTHSIMPLE_TRADE_DEFINITION.trade,
          defaultAccountId: made_up,
        },
      },
      receiptIds: [R1],
    });
    expect(result.unknownAccountIds).toEqual([made_up]);
    expect(result.emails[0].trade?.parsed.complete).toBe(true);
    expect(result.allComplete).toBe(false);
  });
});

describe("EmailReceiptParserToolsService.testDefinition with expected transactions", () => {
  const T1 = "40000000-0000-4000-8000-000000000001";
  const T2 = "40000000-0000-4000-8000-000000000002";

  /** The three statements a sample test runs: the transactions, their splits, the candidates. */
  function withTransactions(
    manager: ReturnType<typeof setup>["manager"],
    rows: Array<Record<string, unknown>>,
  ) {
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM transaction_splits")) return [];
      if (text.includes("JOIN accounts")) return [];
      if (text.includes("t.currency_code")) return rows;
      return [];
    });
  }
  const txRow = (id: string, date: string, amount: string) => ({
    id,
    date,
    amount,
    currency_code: "USD",
    payee_name: "Shop",
    description: null,
    category_id: null,
  });

  it("reports per email whether the parsed date and total agree with its transaction", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.find.mockResolvedValue([
      receipt(),
      receipt({ id: R2, subject: "Second" }),
    ]);
    withTransactions(manager, [
      txRow(T1, "2026-09-11", "-15.0000"),
      txRow(T2, "2026-09-11", "-20.0000"),
    ]);

    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      samples: [
        { receiptId: R1, transactionId: T1 },
        { receiptId: R2, transactionId: T2 },
      ],
    });

    expect(result.emails[0]).toMatchObject({
      receiptId: R1,
      expected: {
        transactionId: T1,
        date: "2026-09-11",
        amount: -15,
        currencyCode: "USD",
      },
      agreement: { date: true, total: true, agrees: true },
    });
    expect(result.emails[1].agreement).toEqual({
      date: true,
      total: false,
      agrees: false,
    });
    expect(result.allAgree).toBe(false);
    expect(result.allComplete).toBe(true);
  });

  it("flags a date outside the profile's window even when the total agrees", async () => {
    const { service, manager } = setup();
    withTransactions(manager, [txRow(T1, "2026-12-01", "-15.0000")]);
    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      samples: [{ receiptId: R1, transactionId: T1 }],
    });
    expect(result.emails[0].agreement).toEqual({
      date: false,
      total: true,
      agrees: false,
    });
  });

  it("is allAgree true when every sample agrees, and reads the transactions through the user's scope", async () => {
    const { service, manager } = setup();
    withTransactions(manager, [txRow(T1, "2026-09-11", "-15.0000")]);
    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      samples: [{ receiptId: R1, transactionId: T1 }],
    });
    expect(result.allAgree).toBe(true);
    const txCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("t.currency_code"),
    );
    expect(String(txCall?.[0])).toContain("t.user_id = $1");
    expect(txCall?.[1]).toEqual([USER, [T1]]);
  });

  it("is a 404 for an expected transaction that is not the user's", async () => {
    const { service, manager } = setup();
    withTransactions(manager, []);
    await expect(
      service.testDefinition(USER, {
        definition: DEFINITION,
        samples: [{ receiptId: R1, transactionId: T1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("stays backward compatible: receiptIds alone name no expectation and allAgree is null", async () => {
    const { service } = setup();
    const result = await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R1],
    });
    expect(result.emails[0]).toMatchObject({
      expected: null,
      agreement: null,
    });
    expect(result.allAgree).toBeNull();
  });

  it("takes the emails from samples when both are sent, and refuses 26", async () => {
    const { service, receiptRepo } = setup();
    await service.testDefinition(USER, {
      definition: DEFINITION,
      receiptIds: [R2],
      samples: [{ receiptId: R1 }],
    });
    expect(
      (receiptRepo.find.mock.calls[0][0].where.id as { _value: string[] })
        ._value,
    ).toEqual([R1]);
    await expect(
      service.testDefinition(USER, {
        definition: DEFINITION,
        samples: Array.from({ length: 26 }, () => ({ receiptId: R1 })),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("EmailReceiptParserToolsService.saveDraft updating a draft", () => {
  const input = {
    name: "Example Shop",
    fromDomains: ["shop.example.com"],
    definition: DEFINITION,
  };
  const existing = (over: Partial<EmailReceiptParser> = {}) =>
    Object.assign(new EmailReceiptParser(), {
      id: "p-old",
      userId: USER,
      status: "draft",
      revision: 4,
      fromDomains: ["shop.example.com"],
      ...over,
    });

  it("updates the named draft in place under the row lock and bumps the revision, creating nothing", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(existing());
    parserRepo.findOneByOrFail.mockResolvedValue(
      existing({ name: "Example Shop", revision: 5 }),
    );

    const result = await service.saveDraft(USER, CALLER, {
      ...input,
      parserId: "p-old",
      expectedRevision: 4,
    });

    expect(parserRepo.findOne).toHaveBeenCalledWith({
      where: { id: "p-old", userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    expect(parserRepo.save).not.toHaveBeenCalled();
    expect(parserRepo.count).not.toHaveBeenCalled();
    const [where, patch] = parserRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "p-old", userId: USER });
    expect(patch).toMatchObject({
      name: "Example Shop",
      fromDomains: ["shop.example.com"],
    });
    expect(patch.revision()).toBe("revision + 1");
    expect(result).toMatchObject({
      parserId: "p-old",
      revision: 5,
      status: "draft",
    });
  });

  it.each([
    ["a stale revision", { revision: 9 }, ConflictException],
    ["an approved parser", { status: "approved" }, ConflictException],
  ])("refuses %s and writes nothing", async (_name, over, error) => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(existing(over as never));
    await expect(
      service.saveDraft(USER, CALLER, {
        ...input,
        parserId: "p-old",
        expectedRevision: 4,
      }),
    ).rejects.toBeInstanceOf(error);
    expect(parserRepo.update).not.toHaveBeenCalled();
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("refuses a missing expectedRevision (the compare-and-swap is not optional)", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(existing());
    await expect(
      service.saveDraft(USER, CALLER, { ...input, parserId: "p-old" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("is a 404 for a draft that is not the user's", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(null);
    await expect(
      service.saveDraft(USER, CALLER, {
        ...input,
        parserId: "p-old",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("EmailReceiptParserToolsService.testDefinition of linked receipts", () => {
  const component = {
    ...ALLEGRO_PAY_COMPONENT_DEFINITION,
    defaultCategoryId: CAT_BOOKS,
    shippingCategoryId: CAT_SHIP,
  };
  const settlement = {
    ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
    defaultCategoryId: CAT_BOOKS,
  };
  const purchaseReceipt = () =>
    receipt({
      id: "component-1",
      subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
      bodyText: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
      receivedAt: new Date("2025-12-15T10:00:00Z"),
    });
  const repaymentReceipt = () =>
    receipt({
      id: "settlement-1",
      subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
      bodyText: ALLEGRO_PAY_REPAYMENT_LINES.join("\n"),
      receivedAt: new Date("2026-01-10T10:00:00Z"),
    });

  it("gives a component email its link key with the line that read it, outcome component and the settlements that wait", async () => {
    const { service, receiptRepo, manager } = setup();
    receiptRepo.find.mockResolvedValue([purchaseReceipt()]);
    manager.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM email_receipt_links l")
        ? Array.from({ length: 25 }, (_, i) => ({
            id: `settlement-${i}`,
            subject: `Repayment ${i}`,
            effective_date: "2026-01-10",
          }))
        : [],
    );

    const result = await service.testDefinition(USER, {
      definition: component,
      receiptIds: ["component-1"],
    });

    const [email] = result.emails;
    expect(email.linkKey?.value).toBe(ALLEGRO_PAY_CONTRACT_2);
    expect(email.linkKey?.hit?.line.text).toContain(ALLEGRO_PAY_CONTRACT_2);
    expect(email.match).toEqual({
      outcome: "component",
      strategy: null,
      transaction: null,
      considered: 0,
      attempts: [],
    });
    expect(email.waitingSettlements).toHaveLength(20);
    expect(email.waitingSettlements?.[0]).toEqual({
      receiptId: "settlement-0",
      subject: "Repayment 0",
      date: "2026-01-10",
    });
    expect(email.links).toBeUndefined();
    expect(email.parsed.linkKey).toBe(ALLEGRO_PAY_CONTRACT_2);
  });

  it("joins the settlement's parts with a drafted component when none is stored, in decimals, with source draft", async () => {
    const { service, receiptRepo, manager } = setup();
    receiptRepo.find.mockResolvedValue([repaymentReceipt()]);
    // The draft reader searches ids first, then reads the bodies of those it needs.
    manager.query.mockImplementation(async (sql: string) =>
      String(sql).includes("r.body_text")
        ? [
            {
              id: "component-1",
              subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
              body_text: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
              body_html: null,
              effective_date: "2025-12-15",
            },
          ]
        : String(sql).includes("r.status <> 'skipped'")
          ? [{ id: "component-1" }]
          : [],
    );

    const result = await service.testDefinition(USER, {
      definition: settlement,
      receiptIds: ["settlement-1"],
      componentDrafts: [
        { definition: component, fromDomains: ["shop.example.com"] },
      ],
    });

    expect(result.valid).toBe(true);
    const part = result.emails[0].links?.find((l) => l.partIndex === 1);
    expect(part).toMatchObject({
      outcome: "joined",
      componentNet: 163,
      component: { receiptId: "component-1", source: "draft" },
    });
    expect(result.emails[0].links?.[0].component).toBeNull();
    expect(result.unknownCategoryIds).toEqual([]);
    expect(result.componentDraftsExhausted).toBe(false);
  });

  it("returns valid:false with the code, not a throw, for a draft beside a definition that is not a settlement", async () => {
    const { service, receiptRepo } = setup();

    const result = await service.testDefinition(USER, {
      definition: component,
      receiptIds: ["component-1"],
      componentDrafts: [
        { definition: component, fromDomains: ["shop.example.com"] },
      ],
    });

    expect(result).toMatchObject({
      valid: false,
      errors: [
        {
          path: "componentDrafts",
          code: "component_draft_requires_settlement",
        },
      ],
      emails: [],
      allComplete: false,
    });
    expect(receiptRepo.find).not.toHaveBeenCalled();
  });

  it("returns valid:false for a draft that is invalid, not a component, or has bad domains, and for too many drafts", async () => {
    const { service } = setup();
    const draft = { definition: component, fromDomains: ["shop.example.com"] };

    const bad = await service.testDefinition(USER, {
      definition: settlement,
      receiptIds: ["settlement-1"],
      componentDrafts: [
        { definition: { total: 5 }, fromDomains: ["nope"] },
        { definition: settlement, fromDomains: ["shop.example.com"] },
      ],
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "component_draft_domain_invalid",
        "component_draft_requires_component",
      ]),
    );
    expect(bad.errors.every((e) => e.path.startsWith("componentDrafts["))).toBe(
      true,
    );

    const many = await service.testDefinition(USER, {
      definition: settlement,
      receiptIds: ["settlement-1"],
      componentDrafts: Array.from({ length: 6 }, () => draft),
    });
    expect(many.errors).toEqual([
      { path: "componentDrafts", code: "component_draft_too_many" },
    ]);
  });

  it("gives a settlement email one entry per part in decimals, and the joined lines with their kind", async () => {
    const { service, receiptRepo, manager } = setup();
    receiptRepo.find.mockResolvedValue([repaymentReceipt()]);
    // The stored component, as the loader reads it: its reading in `parsed`.
    const { dryRunReceipt } = jest.requireActual("./receipt-dry-run");
    const read = await dryRunReceipt(
      { query: jest.fn(async () => []) },
      USER,
      component,
      purchaseReceipt(),
      null,
    );
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM email_receipts r")) {
        return [
          {
            id: "component-1",
            link_key: ALLEGRO_PAY_CONTRACT_2,
            subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
            effective_date: "2025-12-15",
            parsed: read.parsed,
            parser_id: "parser-1",
          },
        ];
      }
      if (text.includes("definition->>'tag'")) {
        return [{ id: "parser-1", tag: null, name: "Shop purchases" }];
      }
      return [];
    });

    const result = await service.testDefinition(USER, {
      definition: settlement,
      receiptIds: ["settlement-1"],
    });

    const [email] = result.emails;
    expect(email.linkKey).toBeUndefined();
    expect(email.waitingSettlements).toBeUndefined();
    expect(email.links).toEqual([
      {
        partIndex: 0,
        link: ALLEGRO_PAY_CONTRACT_1,
        component: null,
        partAmount: 109.89,
        componentNet: null,
        taken: null,
        outcome: "not_found",
        several: 0,
      },
      {
        partIndex: 1,
        link: ALLEGRO_PAY_CONTRACT_2,
        component: {
          receiptId: "component-1",
          subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
          effectiveDate: "2025-12-15",
          profileName: "Shop purchases",
          source: "stored",
        },
        partAmount: 163,
        componentNet: 163,
        taken: 0,
        outcome: "joined",
        several: 1,
      },
    ]);
    expect(email.parsed.items.map((item) => item.amount)).toEqual([
      109.89, 140, 10, 13,
    ]);
    expect(email.parsed.items[3]).toMatchObject({ kind: "shipping" });
    expect(email.parsed.items[1].kind).toBeUndefined();
    expect(email.match.outcome).toBe("unmatched");
  });

  it("lists at most 20 parts of a settlement, as it cuts the trace", async () => {
    const { service, receiptRepo } = setup();
    const block = (n: number) =>
      ALLEGRO_PAY_REPAYMENT_LINES.slice(4, 14).map((line) =>
        line === ALLEGRO_PAY_CONTRACT_1 ? String(2000000000 + n) : line,
      );
    receiptRepo.find.mockResolvedValue([
      receipt({
        subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
        bodyText: [
          ...ALLEGRO_PAY_REPAYMENT_LINES.slice(0, 4),
          ...Array.from({ length: 22 }, (_, n) => block(n)).flat(),
        ].join("\n"),
      }),
    ]);
    const result = await service.testDefinition(USER, {
      definition: settlement,
      receiptIds: [R1],
    });
    expect(result.emails[0].parsed.items).toHaveLength(22);
    expect(result.emails[0].links).toHaveLength(20);
  });
});
