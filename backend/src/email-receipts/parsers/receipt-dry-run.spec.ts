import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { ReceiptParserDefinition } from "../parsing/receipt-parser.types";
import { Category } from "../../categories/entities/category.entity";
import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
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
  compareWithExpected,
  dryRunReceipt,
  loadTransactionSummaries,
  summarizeTransaction,
} from "./receipt-dry-run";
import {
  createDraftComponentReader,
  MAX_DRAFT_COMPONENT_READS,
} from "./component-draft";

const USER = "user-1";
const T1 = "40000000-0000-4000-8000-000000000001";
const T2 = "40000000-0000-4000-8000-000000000002";
const CAT = "11111111-1111-4111-8111-111111111111";

const CONFIG = { daysBefore: 3, daysAfter: 14, toleranceUnits: 0 };

describe("compareWithExpected", () => {
  const expected = { date: "2026-09-11", amount: -15 };

  it("agrees when the transaction is inside the window and the amount equals the total", () => {
    expect(
      compareWithExpected(
        { total: 150000, paid: null },
        "2026-09-10",
        CONFIG,
        expected,
      ),
    ).toEqual({ date: true, total: true, agrees: true });
  });

  it("prefers what was paid to the total, as the matcher does", () => {
    expect(
      compareWithExpected(
        { total: 200000, paid: 150000 },
        "2026-09-10",
        CONFIG,
        expected,
      ).total,
    ).toBe(true);
    expect(
      compareWithExpected(
        { total: 150000, paid: 200000 },
        "2026-09-10",
        CONFIG,
        expected,
      ).total,
    ).toBe(false);
  });

  it("disagrees on the date outside the window, either side", () => {
    expect(
      compareWithExpected({ total: 150000, paid: null }, "2026-09-10", CONFIG, {
        ...expected,
        date: "2026-09-06",
      }).date,
    ).toBe(false);
    expect(
      compareWithExpected({ total: 150000, paid: null }, "2026-09-10", CONFIG, {
        ...expected,
        date: "2026-09-25",
      }).date,
    ).toBe(false);
    // the window edges are inside
    expect(
      compareWithExpected({ total: 150000, paid: null }, "2026-09-10", CONFIG, {
        ...expected,
        date: "2026-09-07",
      }).date,
    ).toBe(true);
    expect(
      compareWithExpected({ total: 150000, paid: null }, "2026-09-10", CONFIG, {
        ...expected,
        date: "2026-09-24",
      }).date,
    ).toBe(true);
  });

  it("honours the profile's amount tolerance, in both directions", () => {
    const tolerant = { ...CONFIG, toleranceUnits: 5000 };
    expect(
      compareWithExpected(
        { total: 154000, paid: null },
        "2026-09-10",
        tolerant,
        expected,
      ).total,
    ).toBe(true);
    expect(
      compareWithExpected(
        { total: 156000, paid: null },
        "2026-09-10",
        tolerant,
        expected,
      ).total,
    ).toBe(false);
    expect(
      compareWithExpected(
        { total: 154000, paid: null },
        "2026-09-10",
        CONFIG,
        expected,
      ).total,
    ).toBe(false);
  });

  it("an email that states no amount does not agree on the total, and a refund is compared by size", () => {
    expect(
      compareWithExpected(
        { total: null, paid: null },
        "2026-09-10",
        CONFIG,
        expected,
      ).agrees,
    ).toBe(false);
    expect(
      compareWithExpected({ total: 150000, paid: null }, "2026-09-10", CONFIG, {
        ...expected,
        amount: 15,
      }).total,
    ).toBe(true);
  });
});

describe("summarizeTransaction", () => {
  it("reads as date, amount with currency, payee", () => {
    expect(
      summarizeTransaction({
        date: "2026-09-11",
        amount: -15,
        currencyCode: "PLN",
        payeeName: "Shop",
      }),
    ).toBe("2026-09-11, -15 PLN, Shop");
    expect(
      summarizeTransaction({
        date: "2026-09-11",
        amount: -15,
        payeeName: null,
      }),
    ).toBe("2026-09-11, -15");
  });
});

describe("loadTransactionSummaries", () => {
  function setup() {
    const categoryRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: CAT, name: "Books", parentId: null }]),
    };
    const { manager } = createScopedDbMocks([[Category, categoryRepo]]);
    return { manager };
  }

  it("asks nothing for no ids", async () => {
    const { manager } = setup();
    await expect(
      loadTransactionSummaries(manager as never, USER, []),
    ).resolves.toEqual(new Map());
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("reads the user's transactions and their split lines in two user-scoped statements", async () => {
    const { manager } = setup();
    manager.query
      .mockResolvedValueOnce([
        {
          id: T1,
          date: "2026-09-11",
          amount: "-15.0000",
          currency_code: "USD",
          payee_name: "Shop",
          description: "Order",
          category_id: null,
        },
        {
          id: T2,
          date: "2026-09-12",
          amount: "-5.0000",
          currency_code: "USD",
          payee_name: null,
          description: null,
          category_id: CAT,
        },
      ])
      .mockResolvedValueOnce([
        {
          transaction_id: T1,
          category_id: CAT,
          amount: "-10.0000",
          memo: null,
        },
        {
          transaction_id: T1,
          category_id: null,
          amount: "-5.0000",
          memo: "ship",
        },
      ]);

    const result = await loadTransactionSummaries(manager as never, USER, [
      T1,
      T2,
    ]);

    expect(manager.query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of manager.query.mock.calls) {
      expect(String(sql)).toContain("t.user_id = $1");
      expect(params[0]).toBe(USER);
    }
    expect(result.get(T1)).toEqual({
      id: T1,
      date: "2026-09-11",
      amount: -15,
      currencyCode: "USD",
      payeeName: "Shop",
      description: "Order",
      categories: [
        { category: "Books", amount: -10, memo: null },
        { category: null, amount: -5, memo: "ship" },
      ],
    });
    expect(result.get(T2)?.categories).toEqual([
      { category: "Books", amount: null, memo: null },
    ]);
  });

  it("leaves out an id that is not the user's", async () => {
    const { manager } = setup();
    manager.query.mockResolvedValueOnce([]);
    const result = await loadTransactionSummaries(manager as never, USER, [T1]);
    expect(result.size).toBe(0);
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});

describe("dryRunReceipt of a trade profile", () => {
  const receipt = {
    id: "r1",
    subject: "Your order has been filled",
    bodyText: WEALTHSIMPLE_BUY_BODY,
    bodyHtml: null,
    receivedAt: new Date("2026-10-15T16:10:19Z"),
    originalSentAt: null,
  };

  it("reads the trade, looks up no bank transaction and matches nothing", async () => {
    const m = { query: jest.fn() };
    const run = await dryRunReceipt(
      m as never,
      USER,
      WEALTHSIMPLE_TRADE_DEFINITION,
      receipt,
      null,
    );
    expect(run.trade?.parsed).toMatchObject({
      action: "BUY",
      symbol: "XCNS",
      quantity: 75.9878,
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      complete: true,
      consistent: true,
    });
    expect(run.trade?.trace.symbol?.line.text).toBe("Symbol: XCNS");
    expect(run.outcome).toBe("read");
    expect(run.match.kind).toBe("unmatched");
    expect(run.candidates).toEqual([]);
    expect(run.hit).toBeUndefined();
    expect(m.query).not.toHaveBeenCalled();
  });

  it("reports the guard that stops the pipeline reading the email", async () => {
    const run = await dryRunReceipt(
      { query: jest.fn() } as never,
      USER,
      WEALTHSIMPLE_TRADE_DEFINITION,
      { ...receipt, bodyText: "Hello\nSomething else" },
      null,
    );
    expect(run.outcome).toBe("not_applicable");
  });

  it("says no_html for a profile that reads the HTML part of an email with none", async () => {
    const run = await dryRunReceipt(
      { query: jest.fn() } as never,
      USER,
      { ...WEALTHSIMPLE_TRADE_DEFINITION, source: "html" },
      receipt,
      null,
    );
    expect(run.outcome).toBe("no_html");
  });
});

describe("dryRunReceipt of linked receipts", () => {
  const purchase = {
    id: "component-1",
    subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
    bodyText: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
    bodyHtml: null,
    receivedAt: new Date("2025-12-15T10:00:00Z"),
    originalSentAt: null,
  };
  const repayment = {
    id: "settlement-1",
    subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
    bodyText: ALLEGRO_PAY_REPAYMENT_LINES.join("\n"),
    bodyHtml: null,
    receivedAt: new Date("2026-01-10T10:00:00Z"),
    originalSentAt: null,
  };

  it("reads a component without a candidate or a matcher, and lists the settlements that wait for its key", async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      sql.includes("FROM email_receipt_links l")
        ? [
            {
              id: "settlement-1",
              subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
              effective_date: "2026-01-10",
            },
          ]
        : [],
    );
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_COMPONENT_DEFINITION,
      purchase,
      null,
    );
    expect(run.outcome).toBe("read");
    expect(run.match).toEqual({
      kind: "unmatched",
      considered: 0,
      attempts: [],
    });
    expect(run.candidates).toEqual([]);
    expect(run.component).toEqual({
      linkKey: ALLEGRO_PAY_CONTRACT_2,
      waitingSettlements: [
        {
          id: "settlement-1",
          subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
          effectiveDate: "2026-01-10",
        },
      ],
    });
    expect(run.trace.linkKey?.line.text).toContain(ALLEGRO_PAY_CONTRACT_2);
    // One statement, the waiting-settlements query: no transaction is read, no lock is taken.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain("FOR UPDATE");
    expect(params).toEqual([USER, "component-1", ALLEGRO_PAY_CONTRACT_2, 20]);
  });

  it("asks for no waiting settlement when the component read no link value or a guard stopped it", async () => {
    const query = jest.fn(async () => []);
    const none = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_COMPONENT_DEFINITION,
      { ...purchase, bodyText: "Nothing to see" },
      null,
    );
    expect(none.component).toEqual({ linkKey: null, waitingSettlements: [] });
    const guarded = await dryRunReceipt(
      { query } as never,
      USER,
      { ...ALLEGRO_PAY_COMPONENT_DEFINITION, requireLine: ["never present"] },
      purchase,
      null,
    );
    expect(guarded.outcome).toBe("not_applicable");
    expect(guarded.component?.waitingSettlements).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  const settlementWorld = async (withComponent: boolean) => {
    const read = await dryRunReceipt(
      { query: jest.fn(async () => []) } as never,
      USER,
      ALLEGRO_PAY_COMPONENT_DEFINITION,
      purchase,
      null,
    );
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM email_receipts r")) {
        return withComponent
          ? [
              {
                id: "component-1",
                link_key: ALLEGRO_PAY_CONTRACT_2,
                subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
                effective_date: "2025-12-15",
                parsed: read.parsed,
                parser_id: "parser-1",
              },
            ]
          : [];
      }
      if (sql.includes("AS taken")) return [];
      if (sql.includes("definition->>'tag'")) {
        return [{ id: "parser-1", tag: "Allegro", name: "Shop purchases" }];
      }
      return [];
    });
    return query;
  };

  it("joins a settlement with its component through the pipeline's loader, without a lock, and matches the joined reading", async () => {
    const query = await settlementWorld(true);
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
    );
    expect(run.component).toBeUndefined();
    expect(run.links).toEqual([
      {
        partIndex: 0,
        link: ALLEGRO_PAY_CONTRACT_1,
        component: null,
        partAmount: 1098900,
        componentNet: null,
        taken: null,
        outcome: "not_found",
        several: 0,
      },
      {
        partIndex: 1,
        link: ALLEGRO_PAY_CONTRACT_2,
        component: {
          id: "component-1",
          subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
          effectiveDate: "2025-12-15",
          profileName: "Shop purchases",
          source: "stored",
        },
        partAmount: 1630000,
        componentNet: 1630000,
        taken: 0,
        outcome: "joined",
        several: 1,
      },
    ]);
    // The part of contract 1 stays one line; the component's three lines replace the other.
    expect(run.parsed.items.map((item) => item.amount)).toEqual([
      1098900, 1400000, 100000, 130000,
    ]);
    expect(run.parsed.links).toHaveLength(2);
    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => sql.includes("FOR UPDATE"))).toBe(false);
    // The candidate search of a settlement keeps the enriched transactions.
    expect(sqls.find((sql) => sql.includes("FROM transactions t"))).toContain(
      "enriched_by_receipt_id",
    );
  });

  it("reads a settlement with no component as one line per part, every part not_found", async () => {
    const query = await settlementWorld(false);
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
    );
    expect(run.links?.map((link) => link.outcome)).toEqual([
      "not_found",
      "not_found",
    ]);
    expect(run.links?.every((link) => link.component === null)).toBe(true);
    expect(run.parsed.items.map((item) => item.amount)).toEqual([
      1098900, 1630000,
    ]);
  });

  it("tests the definition it is given: another link window finds no component", async () => {
    const query = await settlementWorld(true);
    await dryRunReceipt(
      { query } as never,
      USER,
      {
        ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
        link: { fromDomains: ["other.example.net"], daysBefore: 5 },
      },
      repayment,
      null,
    );
    const [, params] = query.mock.calls.find(([sql]) =>
      sql.includes("FROM email_receipts r"),
    ) as [string, unknown[]];
    expect(params[3]).toEqual(["other.example.net"]);
    expect(params[4]).toBe("2026-01-05");
  });

  it("gives a standalone profile neither marker", async () => {
    const run = await dryRunReceipt(
      { query: jest.fn(async () => []) } as never,
      USER,
      { ...ALLEGRO_PAY_COMPONENT_DEFINITION, role: undefined },
      purchase,
      null,
    );
    expect(run.component).toBeUndefined();
    expect(run.links).toBeUndefined();
  });
});

describe("dryRunReceipt of a settlement with componentDrafts", () => {
  const purchase = {
    id: "component-1",
    subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
    bodyText: ALLEGRO_PAY_PURCHASE_LINES.join("\n"),
    bodyHtml: null,
    receivedAt: new Date("2025-12-15T10:00:00Z"),
    originalSentAt: null,
  };
  const repayment = {
    id: "settlement-1",
    subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
    bodyText: ALLEGRO_PAY_REPAYMENT_LINES.join("\n"),
    bodyHtml: null,
    receivedAt: new Date("2026-01-10T10:00:00Z"),
    originalSentAt: null,
  };
  const draft = (
    definition: ReceiptParserDefinition = ALLEGRO_PAY_COMPONENT_DEFINITION,
  ) => ({ definition, fromDomains: ["shop.example.com"] });
  const draftRow = (over: Record<string, unknown> = {}) => ({
    id: "component-1",
    subject: purchase.subject,
    body_text: purchase.bodyText,
    body_html: null,
    effective_date: "2025-12-15",
    ...over,
  });

  /** `stored` rows are what the pipeline's loader finds; `drafted` what the draft read query returns. */
  const world = (stored: unknown[], drafted: unknown[]) =>
    jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("r.body_text")) return drafted;
      // The draft reader's search returns ids only; the bodies come next.
      if (sql.includes("r.status <> 'skipped'")) {
        return (drafted as Array<{ id: string }>).map(({ id }) => ({ id }));
      }
      if (sql.includes("r.link_key")) return stored;
      if (sql.includes("definition->>'tag'")) {
        return [{ id: "parser-1", tag: null, name: "Stored profile" }];
      }
      return [];
    });
  const storedRow = async (over: Record<string, unknown> = {}) => {
    const read = await dryRunReceipt(
      { query: jest.fn(async () => []) } as never,
      USER,
      ALLEGRO_PAY_COMPONENT_DEFINITION,
      purchase,
      null,
    );
    return {
      id: "component-1",
      link_key: ALLEGRO_PAY_CONTRACT_2,
      subject: purchase.subject,
      effective_date: "2025-12-15",
      parsed: read.parsed,
      parser_id: "parser-1",
      ...over,
    };
  };
  const partOf = (run: { links?: Array<{ partIndex: number }> }) =>
    run.links?.find((link) => link.partIndex === 1);

  it("joins a part with a draft reading when no component is stored, marking its source draft, and never writes or locks", async () => {
    const query = world([], [draftRow()]);
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );

    expect(partOf(run)).toMatchObject({
      outcome: "joined",
      several: 1,
      component: {
        id: "component-1",
        effectiveDate: "2025-12-15",
        profileName: null,
        source: "draft",
      },
    });
    expect(run.parsed.items.map((item) => item.amount)).toEqual([
      1098900, 1400000, 100000, 130000,
    ]);
    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(
      false,
    );
    expect(sqls.some((sql) => sql.includes("FOR UPDATE"))).toBe(false);
  });

  it("reads the user's emails not skipped, of the draft's domains, in the settlement's window, newest first, at most 200", async () => {
    const query = world([], []);
    await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );

    const [sql, params] = query.mock.calls.find(([text]) =>
      text.includes("r.status <> 'skipped'"),
    ) as [string, unknown[]];
    expect(sql).toContain("r.status <> 'skipped'");
    expect(sql).toContain("r.user_id = $1");
    expect(sql).toContain("r.id <> $2");
    expect(sql).toMatch(/right\(r\.from_domain/);
    expect(sql).toContain(
      "ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id ASC",
    );
    expect(sql).toContain("LIMIT 200");
    // 120 days before the settlement (2026-01-10) and 7 days after it.
    expect(params).toEqual([
      USER,
      "settlement-1",
      ["shop.example.com"],
      "2025-09-12",
      "2026-01-17",
    ]);
  });

  it("lets a draft reading replace the stored component of the same email", async () => {
    const query = world(
      [
        await storedRow({
          parsed: {
            ...(await storedRow()).parsed,
            complete: false,
            reason: "no_total",
          },
        }),
      ],
      [draftRow()],
    );
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );

    expect(partOf(run)).toMatchObject({
      outcome: "joined",
      several: 1,
      component: { id: "component-1", source: "draft" },
    });
  });

  it("keeps a stored component marked stored when no draft reads that email, and counts both when they are different emails", async () => {
    const query = world(
      [await storedRow()],
      [draftRow({ id: "component-2", effective_date: "2025-12-20" })],
    );
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );

    // two emails carry the key: the newest date is chosen (the draft), and the count says two
    expect(partOf(run)).toMatchObject({
      several: 2,
      component: { id: "component-2", source: "draft" },
    });
    const stored = await dryRunReceipt(
      { query: world([await storedRow()], []) } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );
    expect(partOf(stored)).toMatchObject({
      component: { id: "component-1", source: "stored" },
    });
  });

  it("leaves out an email the draft's guards turn aside, and one whose key no part carries", async () => {
    const guarded = await dryRunReceipt(
      { query: world([], [draftRow()]) } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([
        draft({
          ...ALLEGRO_PAY_COMPONENT_DEFINITION,
          requireLine: ["never present"],
        }),
      ]),
    );
    expect(partOf(guarded)).toMatchObject({
      outcome: "not_found",
      component: null,
    });

    const otherKey = await dryRunReceipt(
      {
        query: world(
          [],
          [
            draftRow({
              body_text: purchase.bodyText.replace(
                ALLEGRO_PAY_CONTRACT_2,
                "9999999999",
              ),
            }),
          ],
        ),
      } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([draft()]),
    );
    expect(partOf(otherKey)).toMatchObject({ outcome: "not_found" });
  });

  it("runs one read per draft and takes an email two drafts both read once", async () => {
    const query = world([], [draftRow()]);
    const run = await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      createDraftComponentReader([
        draft(),
        { ...draft(), fromDomains: ["other.example.com"] },
      ]),
    );

    const searches = query.mock.calls.filter(([sql]) =>
      sql.includes("r.status <> 'skipped'"),
    );
    expect(searches).toHaveLength(2);
    expect(searches[1][1]?.[2]).toEqual(["other.example.com"]);
    expect(partOf(run)).toMatchObject({
      several: 1,
      component: { source: "draft" },
    });
  });

  it("reads nothing with a draft when the settlement's parts carry no key", async () => {
    const query = world([], [draftRow()]);
    await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      { ...repayment, bodyText: "Nothing to see" },
      null,
      createDraftComponentReader([draft()]),
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("r.body_text"))).toBe(
      false,
    );
  });

  it("reads each email once per draft for the whole call when one reader serves several emails", async () => {
    const query = world([], [draftRow()]);
    const reader = createDraftComponentReader([draft()]);
    for (let i = 0; i < 3; i++) {
      const run = await dryRunReceipt(
        { query } as never,
        USER,
        ALLEGRO_PAY_SETTLEMENT_DEFINITION,
        { ...repayment, id: `repayment-${i}` },
        null,
        reader,
      );
      expect(partOf(run)).toMatchObject({ component: { source: "draft" } });
    }
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("r.body_text")),
    ).toHaveLength(1);
    expect(reader.exhausted).toBe(false);
  });

  it("stops at the call's read limit over every draft and email, and says so", async () => {
    const many = Array.from({ length: MAX_DRAFT_COMPONENT_READS + 1 }, (_, i) =>
      draftRow({ id: `component-${i}` }),
    );
    const query = world([], many);
    const reader = createDraftComponentReader([
      draft(),
      { ...draft(), fromDomains: ["other.example.com"] },
    ]);
    await dryRunReceipt(
      { query } as never,
      USER,
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      repayment,
      null,
      reader,
    );
    const bodyReads = query.mock.calls.filter(([sql]) =>
      sql.includes("r.body_text"),
    );
    const read = bodyReads.reduce(
      (sum, [, params]) => sum + (params?.[1] as string[]).length,
      0,
    );
    expect(read).toBe(MAX_DRAFT_COMPONENT_READS);
    expect(reader.exhausted).toBe(true);
  });
});
