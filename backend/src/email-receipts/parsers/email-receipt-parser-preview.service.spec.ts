import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
} from "../parsing/fixtures/allegro-pay-mails";
import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
  WEALTHSIMPLE_TRADE_DEFINITION,
} from "../parsing/fixtures/wealthsimple-trade";
import {
  EmailReceiptParserPreviewService,
  PARSER_PREVIEW_MAX_OTHERS,
} from "./email-receipt-parser-preview.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const PARSER = "20000000-0000-4000-8000-000000000001";
const R1 = "30000000-0000-4000-8000-000000000001";
const R2 = "30000000-0000-4000-8000-000000000002";
const R3 = "30000000-0000-4000-8000-000000000003";
const T1 = "40000000-0000-4000-8000-000000000001";

const DEFINITION = {
  version: 2,
  orderId: ["Order number: {orderid}"],
  total: ["Order total: {amount}"],
  items: {
    patterns: ["{name} {amount}"],
    startAfter: "Items",
    stopAt: "Total",
  },
  defaultCategoryId: "11111111-1111-4111-8111-111111111111",
};

const parserRow = (over: Partial<EmailReceiptParser> = {}) =>
  Object.assign(new EmailReceiptParser(), {
    id: PARSER,
    userId: USER,
    fromDomains: ["shop.example.com"],
    payeeId: null,
    status: "draft",
    definition: DEFINITION,
    ...over,
  });

const mail = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subject: `Order ${id.slice(-1)}`,
  body_text: [
    "Order number: ABCD1234",
    "Items",
    "Widget 15.00",
    "Order total: 15.00",
  ].join("\n"),
  body_html: null,
  received_at: new Date("2026-09-10T10:00:00Z"),
  original_sent_at: null,
  in_domain: true,
  ...over,
});

function setup(
  data: {
    selected?: Array<Record<string, unknown>>;
    others?: Array<Record<string, unknown>>;
    othersTotal?: number;
    transactions?: Array<Record<string, unknown>>;
    candidates?: Array<Record<string, unknown>>;
    parser?: EmailReceiptParser | null;
  } = {},
) {
  const parserRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue(data.parser === undefined ? parserRow() : data.parser),
  };
  const payeeRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const categoryRepo = { find: jest.fn().mockResolvedValue([]) };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceiptParser, parserRepo],
    [Payee, payeeRepo],
    [Category, categoryRepo],
  ]);
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("COUNT(*)::int AS n")) {
      return [{ n: data.othersTotal ?? data.others?.length ?? 0 }];
    }
    if (text.includes("AS in_domain")) {
      return text.includes("NOT (r.id = ANY")
        ? (data.others ?? [])
        : (data.selected ?? []);
    }
    if (text.includes("FROM transaction_splits")) return [];
    if (text.includes("t.currency_code")) return data.transactions ?? [];
    if (text.includes("JOIN accounts")) return data.candidates ?? [];
    return [];
  });
  const service = new EmailReceiptParserPreviewService(dataSource as never);
  return { service, manager, parserRepo, payeeRepo };
}

const candidate = (over: Record<string, unknown> = {}) => ({
  id: T1,
  transaction_date: "2026-09-11",
  amount: "-15.0000",
  payee_id: null,
  payee_name: "Shop",
  description: "Order ABCD1234",
  reference_number: null,
  ...over,
});

describe("EmailReceiptParserPreviewService.preview", () => {
  it("runs the parser over the selected samples and the other emails of its domains, and writes nothing", async () => {
    const { service, manager } = setup({
      selected: [mail(R1)],
      others: [mail(R2), mail(R3, { body_text: "nothing here" })],
      othersTotal: 250,
      candidates: [candidate()],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      receiptId: R1,
      outcome: "matched",
      statusReason: null,
      parsed: { date: "2026-09-10", total: 15, lineCount: 1 },
      match: { transactionId: T1 },
      expected: null,
      agrees: null,
    });
    expect(result.selected[0].match?.summary).toContain("2026-09-11");
    expect(result.others.map((o) => [o.receiptId, o.outcome])).toEqual([
      [R2, "matched"],
      [R3, "parse_failed"],
    ]);
    expect(result.others[1]).toMatchObject({
      statusReason: "no_total",
      match: null,
    });
    expect(result.othersTotal).toBe(250);
    for (const [sql] of manager.query.mock.calls) {
      expect(String(sql).trim()).toMatch(/^SELECT/);
    }
  });

  it("dates each email by when the shop sent it, else when it arrived", async () => {
    const { service } = setup({
      selected: [
        mail(R1, { original_sent_at: new Date("2026-09-03T08:00:00Z") }),
      ],
      others: [mail(R2)],
    });
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });
    expect(result.selected[0]).toMatchObject({
      receivedAt: "2026-09-10T10:00:00.000Z",
      effectiveDate: "2026-09-03T08:00:00.000Z",
    });
    expect(result.others[0].effectiveDate).toBe("2026-09-10T10:00:00.000Z");
  });

  it("works for a draft and an approved parser alike", async () => {
    for (const status of ["draft", "approved"] as const) {
      const { service } = setup({
        parser: parserRow({ status }),
        selected: [mail(R1)],
      });
      await expect(
        service.preview(USER, PARSER, { selectedReceiptIds: [R1] }),
      ).resolves.toMatchObject({ selected: [{ receiptId: R1 }] });
    }
  });

  it("reports whether a selected email's parse agrees with its expected transaction, in the order selected", async () => {
    const { service } = setup({
      selected: [mail(R1), mail(R2)],
      transactions: [
        {
          id: T1,
          date: "2026-09-11",
          amount: "-15.0000",
          currency_code: "USD",
          payee_name: "Shop",
          description: null,
          category_id: null,
        },
      ],
      candidates: [candidate()],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R2, R1],
      expected: [{ receiptId: R1, transactionId: T1 }],
    });

    expect(result.selected.map((s) => s.receiptId)).toEqual([R2, R1]);
    expect(result.selected[0]).toMatchObject({ expected: null, agrees: null });
    expect(result.selected[1]).toMatchObject({
      expected: { transactionId: T1 },
      agrees: true,
      parsed: { currency: "USD" },
    });
  });

  it("disagrees when the expected transaction is another amount", async () => {
    const { service } = setup({
      selected: [mail(R1)],
      transactions: [
        {
          id: T1,
          date: "2026-09-11",
          amount: "-99.0000",
          currency_code: "USD",
          payee_name: null,
          description: null,
          category_id: null,
        },
      ],
    });
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
      expected: [{ receiptId: R1, transactionId: T1 }],
    });
    expect(result.selected[0].agrees).toBe(false);
  });

  it("caps the others at 100 newest, and counts them all", async () => {
    const { service, manager } = setup({
      selected: [],
      others: [],
      othersTotal: 340,
    });
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [],
    });
    expect(result).toEqual({ selected: [], others: [], othersTotal: 340 });
    const othersCall = manager.query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("AS in_domain") &&
        String(sql).includes("NOT (r.id = ANY"),
    );
    expect(String(othersCall?.[0])).toContain(
      "ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC",
    );
    expect(String(othersCall?.[0])).toContain("r.status <> 'skipped'");
    expect(othersCall?.[1]).toEqual([
      USER,
      ["shop.example.com"],
      [],
      PARSER_PREVIEW_MAX_OTHERS,
    ]);
    expect(PARSER_PREVIEW_MAX_OTHERS).toBe(100);
  });

  it("matches the sub-domain rule of the pipeline in SQL, scoped to the user", async () => {
    const { service, manager } = setup({ selected: [mail(R1)] });
    await service.preview(USER, PARSER, { selectedReceiptIds: [R1] });
    for (const [sql] of manager.query.mock.calls) {
      const text = String(sql);
      if (text.includes("FROM email_receipts")) {
        expect(text).toContain("r.user_id = $1");
        expect(text).toContain("right(r.from_domain, length(pd.domain) + 1)");
      }
    }
  });

  it("reports a guard's outcome and no parsed figures when the parser does not apply", async () => {
    const { service } = setup({
      parser: parserRow({
        definition: { ...DEFINITION, requireLine: ["Never present"] },
      }),
      selected: [mail(R1)],
    });
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });
    expect(result.selected[0]).toMatchObject({
      outcome: "not_applicable",
      parsed: null,
      match: null,
    });
  });

  it("is a 404 for a parser that is not the user's, before reading any email", async () => {
    const { service, manager } = setup({ parser: null });
    await expect(
      service.preview(USER, PARSER, { selectedReceiptIds: [R1] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("is a 400 listing the codes for a parser whose definition is not valid", async () => {
    const { service } = setup({ parser: parserRow({ definition: {} }) });
    await expect(
      service.preview(USER, PARSER, { selectedReceiptIds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is a 404 for a selected email that is not the user's", async () => {
    const { service } = setup({ selected: [] });
    await expect(
      service.preview(USER, PARSER, { selectedReceiptIds: [R1] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is a 400 for a selected email of another domain", async () => {
    const { service } = setup({ selected: [mail(R1, { in_domain: false })] });
    await expect(
      service.preview(USER, PARSER, { selectedReceiptIds: [R1] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is a 404 for an expected transaction that is not the user's", async () => {
    const { service } = setup({ selected: [mail(R1)], transactions: [] });
    await expect(
      service.preview(USER, PARSER, {
        selectedReceiptIds: [R1],
        expected: [{ receiptId: R1, transactionId: T1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is a 400 for an expectation on an email that is not selected, reading nothing", async () => {
    const { service, parserRepo } = setup();
    await expect(
      service.preview(USER, PARSER, {
        selectedReceiptIds: [R1],
        expected: [{ receiptId: R2, transactionId: T1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(parserRepo.findOne).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptParserPreviewService.preview of a trade profile", () => {
  const tradeParser = () =>
    parserRow({
      fromDomains: ["wealthsimple.com"],
      definition: WEALTHSIMPLE_TRADE_DEFINITION as never,
    });
  const filled = (id: string, over: Record<string, unknown> = {}) =>
    mail(id, { body_text: WEALTHSIMPLE_BUY_BODY, ...over });

  it("shows which of two accounts printed alike a sample books to, by its currency", async () => {
    const RRSP_USD = "33333333-3333-4333-8333-333333333333";
    const { service } = setup({
      parser: parserRow({
        fromDomains: ["wealthsimple.com"],
        definition: {
          ...WEALTHSIMPLE_TRADE_DEFINITION,
          trade: {
            ...WEALTHSIMPLE_TRADE_DEFINITION.trade,
            accountRules: [
              { match: "RRSP", currency: "USD", accountId: RRSP_USD },
              {
                match: "RRSP",
                currency: "CAD",
                accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
              },
            ],
          },
        } as never,
      }),
      selected: [
        filled(R1, {
          body_text: WEALTHSIMPLE_BUY_BODY.replace(
            "Total cost: $2,000.00",
            "Total cost: US$2,000.00",
          ),
        }),
      ],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });

    expect(result.selected[0]).toMatchObject({
      outcome: "trade",
      parsed: { total: 2000, currency: "USD" },
      trade: { accountId: RRSP_USD, currency: "USD" },
    });
  });

  it("reports a complete trade as `trade`, with what it read, and looks up no bank transaction", async () => {
    const { service, manager } = setup({
      parser: tradeParser(),
      selected: [filled(R1)],
      others: [
        filled(R2, {
          body_text: WEALTHSIMPLE_BUY_BODY.replace("Symbol:", "Ticker:"),
        }),
        filled(R3, { body_text: "Hello\nWorld" }),
      ],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });

    expect(result.selected[0]).toMatchObject({
      outcome: "trade",
      statusReason: null,
      parsed: { date: "2026-10-15", total: 2000 },
      trade: {
        action: "BUY",
        symbol: "XCNS",
        quantity: 75.9878,
        consistent: true,
        accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
        currency: null,
      },
      match: null,
    });
    expect(
      result.others.map((o) => [o.receiptId, o.outcome, o.statusReason]),
    ).toEqual([
      [R2, "parse_failed", "trade_no_symbol"],
      [R3, "not_applicable", null],
    ]);
    expect(result.others[0].trade).toMatchObject({ symbol: null });
    expect(result.others[1].trade).toBeNull();
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("JOIN accounts"))).toBe(false);
  });

  it("says `trade_exists` for a trade the ledger already holds, as the pipeline would ignore it", async () => {
    const { service, manager } = setup({
      parser: tradeParser(),
      selected: [filled(R1)],
      others: [],
    });
    const fallback = manager.query.getMockImplementation();
    manager.query.mockImplementation(async (sql: string, params: unknown[]) =>
      String(sql).includes("FROM investment_transactions it")
        ? [{ id: "it-1", claimed: false }]
        : fallback?.(sql, params),
    );
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });
    expect(result.selected[0].outcome).toBe("trade_exists");
  });

  it("shows the total a price-only trade proposes, as the pipeline computes it", async () => {
    const priceOnly = parserRow({
      fromDomains: ["wealthsimple.com"],
      definition: {
        ...WEALTHSIMPLE_TRADE_DEFINITION,
        trade: { ...WEALTHSIMPLE_TRADE_DEFINITION.trade, total: undefined },
      } as never,
    });
    const { service } = setup({
      parser: priceOnly,
      selected: [filled(R1)],
      others: [],
    });
    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });
    expect(result.selected[0].parsed?.total).toBe(1999.9989);
  });
});

describe("EmailReceiptParserPreviewService.preview of a component profile", () => {
  const componentParser = () =>
    parserRow({
      fromDomains: ["shop.example.com"],
      definition: ALLEGRO_PAY_COMPONENT_DEFINITION as never,
    });
  const purchase = (id: string, over: Record<string, unknown> = {}) =>
    mail(id, {
      subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
      body_text: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
      ...over,
    });

  it("reports an email read with a link value as `component`, matched to nothing, and looks up no bank transaction", async () => {
    const { service, manager } = setup({
      parser: componentParser(),
      selected: [purchase(R1)],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });

    expect(result.selected[0]).toMatchObject({
      outcome: "component",
      statusReason: null,
      match: null,
      parsed: { total: 163, lineCount: 2 },
    });
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("JOIN accounts"),
      ),
    ).toBe(false);
  });

  it("reports a component email that read no link value as parse_failed with no_link_key", async () => {
    const { service } = setup({
      parser: componentParser(),
      selected: [
        purchase(R1, {
          body_text: ALLEGRO_PAY_PURCHASE_LINES.filter(
            (line) => !line.includes("Allegro Pay") && !line.includes("umowa"),
          ).join("\n"),
        }),
      ],
    });

    const result = await service.preview(USER, PARSER, {
      selectedReceiptIds: [R1],
    });

    expect(result.selected[0]).toMatchObject({
      outcome: "parse_failed",
      statusReason: "no_link_key",
    });
  });
});
