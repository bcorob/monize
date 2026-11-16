import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { AiBaseUrlRefusedError } from "../../ai/ai-base-url-policy";
import { Category } from "../../categories/entities/category.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { FINANCIAL_TOOLS } from "../../ai/query/tool-definitions";
import {
  EmailReceiptParserGenerateService,
  PARSER_RUN_EXCLUDED_TOOLS,
} from "./email-receipt-parser-generate.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const R1 = "30000000-0000-4000-8000-000000000001";
const R2 = "30000000-0000-4000-8000-000000000002";
const T1 = "40000000-0000-4000-8000-000000000001";
const T2 = "40000000-0000-4000-8000-000000000002";
const P_OLD = "20000000-0000-4000-8000-000000000001";
const P_NEW = "20000000-0000-4000-8000-000000000002";

const receipt = (id: string, over: Partial<EmailReceipt> = {}) =>
  Object.assign(new EmailReceipt(), {
    id,
    userId: USER,
    fromDomain: "shop.example.com",
    subject: "Your order",
    bodyText: "Order total: 15.00",
    bodyHtml: null,
    status: "no_parser",
    receivedAt: new Date("2026-09-10T10:00:00Z"),
    originalSentAt: null,
    ...over,
  });

const draft = (over: Partial<EmailReceiptParser> = {}) =>
  Object.assign(new EmailReceiptParser(), {
    id: P_OLD,
    userId: USER,
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition: { version: 2, total: ["Order total: {amount}"] },
    status: "draft",
    revision: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
    ...over,
  });

const txRow = (id: string) => ({
  id,
  date: "2026-09-11",
  amount: "-15.0000",
  currency_code: "USD",
  payee_name: "Shop",
  description: null,
  category_id: null,
});

function setup(
  data: {
    receipts?: EmailReceipt[];
    transactions?: string[];
    known?: Array<Partial<EmailReceiptParser>>;
    target?: EmailReceiptParser | null;
    after?: Array<Partial<EmailReceiptParser>>;
    afterTarget?: Partial<EmailReceiptParser> | null;
    /** The user has no direct tool-capable provider. */
    noDirectProvider?: boolean;
    relayActive?: boolean;
  } = {},
) {
  const receiptRepo = {
    find: jest.fn().mockResolvedValue(data.receipts ?? [receipt(R1)]),
  };
  const parserRepo = {
    find: jest
      .fn()
      .mockResolvedValueOnce(data.known ?? [])
      .mockResolvedValue(data.after ?? []),
    findOne: jest
      .fn()
      .mockResolvedValueOnce(data.target ?? null)
      .mockResolvedValue(data.afterTarget ?? null),
  };
  const categoryRepo = { find: jest.fn().mockResolvedValue([]) };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
    [EmailReceiptParser, parserRepo],
    [Category, categoryRepo],
  ]);
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM transaction_splits")) return [];
    if (text.includes("t.currency_code")) {
      return (data.transactions ?? [T1]).map(txRow);
    }
    return [];
  });
  const aiQuery = {
    executeQuery: jest.fn().mockResolvedValue({ answer: "Saved the draft." }),
  };
  const ai = {
    resolveToolUseProvider: data.noDirectProvider
      ? jest
          .fn()
          .mockRejectedValue(
            new BadRequestException("No AI provider with tool use support."),
          )
      : jest.fn().mockResolvedValue({ provider: {}, config: {} }),
    getStatus: jest
      .fn()
      .mockResolvedValue({ relayActive: data.relayActive ?? false }),
  };
  const requests = {
    queueParserDraft: jest.fn().mockResolvedValue({ id: "req-1" }),
  };
  const service = new EmailReceiptParserGenerateService(
    dataSource as never,
    aiQuery as never,
    ai as never,
    requests as never,
  );
  return { service, manager, receiptRepo, parserRepo, aiQuery, ai, requests };
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    domain: "shop.example.com",
    samples: [{ receiptId: R1, transactionId: T1 }],
    ...over,
  }) as never;

describe("EmailReceiptParserGenerateService.generate", () => {
  it("runs the assistant over the samples and returns the draft it created", async () => {
    const { service, aiQuery } = setup({
      known: [{ id: P_OLD }],
      after: [
        { id: P_NEW, revision: 1 },
        { id: P_OLD, revision: 3 },
      ],
    });

    await expect(service.generate(USER, dto())).resolves.toEqual({
      status: "saved",
      parserId: P_NEW,
      revision: 1,
      answer: "Saved the draft.",
    });

    expect(aiQuery.executeQuery).toHaveBeenCalledTimes(1);
    const [userId, prompt] = aiQuery.executeQuery.mock.calls[0];
    expect(userId).toBe(USER);
    expect(prompt).toContain("shop.example.com");
    expect(prompt).toContain("Order total: 15.00");
    expect(prompt).toContain(T1);
    expect(prompt).toContain("email_receipt_parsers");
  });

  it("withdraws every network-writing tool from the run: its prompt carries untrusted email content (R2-4)", async () => {
    const { service, aiQuery } = setup({
      known: [{ id: P_OLD }],
      after: [
        { id: P_NEW, revision: 1 },
        { id: P_OLD, revision: 3 },
      ],
    });
    await service.generate(USER, dto());
    const options = aiQuery.executeQuery.mock.calls[0][4];
    expect(options).toEqual({ excludeTools: PARSER_RUN_EXCLUDED_TOOLS });
    expect(options.excludeTools).toContain("fetch_bond_series");
  });

  describe("the tool set of the generator's run", () => {
    const offered = FINANCIAL_TOOLS.filter(
      (tool) => !PARSER_RUN_EXCLUDED_TOOLS.includes(tool.name),
    );

    it("contains no tool that fetches from the network or writes the bond catalog", () => {
      const names = offered.map((tool) => tool.name);
      expect(names).not.toContain("fetch_bond_series");
      expect(names.filter((name) => /fetch|bond_series/i.test(name))).toEqual(
        [],
      );
      // Every tool of that kind the assistant has is on the exclusion list, so
      // a new one is withdrawn here by being named in one place.
      const networkWriting = FINANCIAL_TOOLS.filter((tool) =>
        /fetch|bond_series/i.test(tool.name),
      ).map((tool) => tool.name);
      expect([...PARSER_RUN_EXCLUDED_TOOLS].sort()).toEqual(
        networkWriting.sort(),
      );
    });

    it("keeps the tool the run exists for", () => {
      expect(offered.map((tool) => tool.name)).toContain(
        "email_receipt_parsers",
      );
    });
  });

  it("revises the named draft: the prompt carries it and the note, and the answer is its new revision", async () => {
    const { service, aiQuery } = setup({
      target: draft(),
      afterTarget: { id: P_OLD, revision: 4 },
    });

    await expect(
      service.generate(
        USER,
        dto({ parserId: P_OLD, feedback: " add shipping " }),
      ),
    ).resolves.toEqual({
      status: "saved",
      parserId: P_OLD,
      revision: 4,
      answer: "Saved the draft.",
    });

    const prompt = aiQuery.executeQuery.mock.calls[0][1] as string;
    expect(prompt).toContain(`parserId "${P_OLD}" and expectedRevision 3`);
    expect(prompt).toContain("add shipping");
    expect(prompt).toContain("Order total: {amount}");
  });

  it("is a 422 carrying the assistant's answer when no draft was created", async () => {
    const { service, aiQuery } = setup({
      known: [{ id: P_OLD }],
      after: [{ id: P_OLD, revision: 3 }],
    });
    aiQuery.executeQuery.mockResolvedValue({ answer: "I could not read it." });

    const error = await service.generate(USER, dto()).catch((e) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toMatchObject({
      answer: "I could not read it.",
      message: expect.any(String),
    });
  });

  it("is a 422 when a revision left the draft's revision where it was", async () => {
    const { service } = setup({
      target: draft(),
      afterTarget: { id: P_OLD, revision: 3 },
    });
    await expect(
      service.generate(USER, dto({ parserId: P_OLD })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("refuses a user with neither a provider nor a relay, before the assistant is called", async () => {
    const { service, aiQuery, requests } = setup({ noDirectProvider: true });
    const error = await service.generate(USER, dto()).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("No AI is set up");
    expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    expect(requests.queueParserDraft).not.toHaveBeenCalled();
  });

  it("passes on a provider refusal that is not 'no provider' (a refused base URL) when there is no relay", async () => {
    const { service, ai } = setup({ noDirectProvider: true });
    const refusal = new AiBaseUrlRefusedError("base URL refused");
    ai.resolveToolUseProvider.mockRejectedValue(refusal);
    await expect(service.generate(USER, dto())).rejects.toBe(refusal);
  });

  describe("a user whose AI is their own agent (the MCP relay)", () => {
    it("queues a request instead of calling a provider and returns its id", async () => {
      const { service, aiQuery, requests, ai } = setup({
        noDirectProvider: true,
        relayActive: true,
      });
      await expect(service.generate(USER, dto())).resolves.toEqual({
        status: "queued",
        requestId: "req-1",
      });
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
      expect(ai.getStatus).toHaveBeenCalledWith(USER);
      const [, userId, input] = requests.queueParserDraft.mock.calls[0];
      expect(userId).toBe(USER);
      expect(input.emailReceiptIds).toEqual([R1]);
      expect(input.parserDomain).toBe("shop.example.com");
      expect(input.instruction).toContain(T1);
      expect(input.instruction).toContain("2026-09-11");
      expect(input.instruction).toContain("-15 USD");
      expect(input.instruction).toContain("save_draft");
    });

    it("carries the draft and the note of a revision", async () => {
      const { service, requests } = setup({
        noDirectProvider: true,
        relayActive: true,
        target: draft(),
      });
      await service.generate(
        USER,
        dto({ parserId: P_OLD, feedback: " add shipping " }),
      );
      const instruction = requests.queueParserDraft.mock.calls[0][2]
        .instruction as string;
      expect(instruction).toContain('Revise the current draft "Shop"');
      expect(instruction).toContain("Order total: {amount}");
      expect(instruction).toContain("Note: add shipping");
    });

    it("prefers a direct provider over the relay", async () => {
      const { service, requests, aiQuery } = setup({
        relayActive: true,
        after: [{ id: P_NEW, revision: 1 }],
      });
      await expect(service.generate(USER, dto())).resolves.toMatchObject({
        status: "saved",
      });
      expect(aiQuery.executeQuery).toHaveBeenCalledTimes(1);
      expect(requests.queueParserDraft).not.toHaveBeenCalled();
    });

    it("checks the samples before queueing: a foreign email is a 404 and nothing is queued", async () => {
      const { service, requests } = setup({
        noDirectProvider: true,
        relayActive: true,
        receipts: [],
      });
      await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(requests.queueParserDraft).not.toHaveBeenCalled();
    });

    it("passes on the 409 of a request the agent has claimed", async () => {
      const { service, requests } = setup({
        noDirectProvider: true,
        relayActive: true,
      });
      requests.queueParserDraft.mockRejectedValue(
        new ConflictException("agent is working"),
      );
      await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  it("reads the emails and transactions through the user's scope", async () => {
    const { service, receiptRepo, manager } = setup({
      after: [{ id: P_NEW, revision: 1 }],
    });
    await service.generate(USER, dto());
    expect(receiptRepo.find.mock.calls[0][0].where.userId).toBe(USER);
    const txCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("t.currency_code"),
    );
    expect(String(txCall?.[0])).toContain("t.user_id = $1");
    expect(txCall?.[1]).toEqual([USER, [T1]]);
  });

  it("accepts an email of a sub-domain of the domain", async () => {
    const { service } = setup({
      receipts: [receipt(R1, { fromDomain: "mail.shop.example.com" })],
      after: [{ id: P_NEW, revision: 1 }],
    });
    await expect(service.generate(USER, dto())).resolves.toMatchObject({
      parserId: P_NEW,
    });
  });

  describe("refuses before the provider is called", () => {
    it("an email that is not the user's: 404", async () => {
      const { service, aiQuery } = setup({ receipts: [] });
      await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    });

    it("a transaction that is not the user's: 404", async () => {
      const { service, aiQuery } = setup({ transactions: [] });
      await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    });

    it("an email of another domain (not a look-alike suffix either): 400", async () => {
      for (const fromDomain of ["other.example.com", "notshop.example.com"]) {
        const { service, aiQuery } = setup({
          receipts: [receipt(R1, { fromDomain })],
        });
        await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(aiQuery.executeQuery).not.toHaveBeenCalled();
      }
    });

    it("a skipped email, which has no text: 409", async () => {
      const { service, aiQuery } = setup({
        receipts: [receipt(R1, { status: "skipped" })],
      });
      await expect(service.generate(USER, dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    });

    it("a revision of a parser that is not the user's: 404", async () => {
      const { service, aiQuery } = setup({ target: null });
      await expect(
        service.generate(USER, dto({ parserId: P_OLD })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    });

    it("a revision of an approved parser: 409", async () => {
      const { service, aiQuery } = setup({
        target: draft({ status: "approved" }),
      });
      await expect(
        service.generate(USER, dto({ parserId: P_OLD })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(aiQuery.executeQuery).not.toHaveBeenCalled();
    });

    it("writes nothing itself in any case", async () => {
      const { service, manager } = setup({
        after: [{ id: P_NEW, revision: 1 }],
      });
      await service.generate(USER, dto());
      for (const [sql] of manager.query.mock.calls) {
        expect(String(sql).trim()).toMatch(/^SELECT/);
      }
    });
  });

  it("uses the HTML lines when the email has no text", async () => {
    const { service, aiQuery } = setup({
      receipts: [
        receipt(R1, {
          bodyText: "",
          bodyHtml: "<p>Order total: <b>15.00</b></p>",
        }),
      ],
      after: [{ id: P_NEW, revision: 1 }],
    });
    await service.generate(
      USER,
      dto({ samples: [{ receiptId: R1, transactionId: T1 }] }),
    );
    expect(aiQuery.executeQuery.mock.calls[0][1]).toContain("Email html lines");
  });
});

describe("two samples", () => {
  it("lists both in the prompt", async () => {
    const { service, aiQuery } = setup({
      receipts: [receipt(R1), receipt(R2)],
      transactions: [T1, T2],
      after: [{ id: P_NEW, revision: 1 }],
    });
    await service.generate(
      USER,
      dto({
        samples: [
          { receiptId: R1, transactionId: T1 },
          { receiptId: R2, transactionId: T2 },
        ],
      }),
    );
    const prompt = aiQuery.executeQuery.mock.calls[0][1] as string;
    expect(prompt).toContain("=== Sample 2 ===");
    expect(prompt).toContain(R2);
    expect(prompt).toContain(T2);
  });
});

describe("generating a trade profile", () => {
  const tradeDto = (over: Record<string, unknown> = {}) =>
    ({
      domain: "shop.example.com",
      kind: "trade",
      tradeReceiptIds: [R1],
      ...over,
    }) as never;

  it("asks for a trade profile over emails only, never reading a transaction", async () => {
    const { service, aiQuery, manager } = setup({
      known: [{ id: P_OLD }],
      after: [{ id: P_NEW, revision: 1 }],
      receipts: [receipt(R1, { bodyText: "Symbol: XCNS" })],
    });
    await expect(service.generate(USER, tradeDto())).resolves.toMatchObject({
      status: "saved",
      parserId: P_NEW,
    });
    const [, prompt] = aiQuery.executeQuery.mock.calls[0];
    expect(prompt).toContain("trade-confirmation profile");
    expect(prompt).toContain("investmentAccounts");
    expect(prompt).toContain("Symbol: XCNS");
    expect(prompt).toContain(`receiptIds = ["${R1}"]`);
    expect(prompt).not.toContain("It paid for this transaction");
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("t.currency_code"))).toBe(false);
  });

  it.each([
    ["a trade request without tradeReceiptIds", { tradeReceiptIds: undefined }],
    [
      "a trade request that also sends samples",
      { samples: [{ receiptId: R1, transactionId: T1 }] },
    ],
    [
      "a receipt request that sends tradeReceiptIds",
      {
        kind: "receipt",
        samples: [{ receiptId: R1, transactionId: T1 }],
      },
    ],
    [
      "a receipt request without samples",
      { kind: undefined, tradeReceiptIds: undefined },
    ],
  ])("refuses %s before any provider is called", async (_why, over) => {
    const { service, aiQuery } = setup({
      receipts: [receipt(R1, { bodyText: "Symbol: XCNS" })],
    });
    await expect(service.generate(USER, tradeDto(over))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(aiQuery.executeQuery).not.toHaveBeenCalled();
  });

  it("queues the trade instruction for the user's own agent", async () => {
    const { service, requests } = setup({
      noDirectProvider: true,
      relayActive: true,
    });
    await service.generate(USER, tradeDto());
    const [, , input] = requests.queueParserDraft.mock.calls[0];
    expect(input.emailReceiptIds).toEqual([R1]);
    expect(input.instruction).toContain("trade-confirmation profile");
    expect(input.instruction).not.toContain("tx:");
  });

  it("still refuses an email of another domain, a foreign email and a skipped one before the provider is called", async () => {
    let h = setup({
      receipts: [receipt(R1, { fromDomain: "evil-shop.example.com" })],
    });
    await expect(h.service.generate(USER, tradeDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    h = setup({ receipts: [] });
    await expect(h.service.generate(USER, tradeDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h = setup({ receipts: [receipt(R1, { status: "skipped" })] });
    await expect(h.service.generate(USER, tradeDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.aiQuery.executeQuery).not.toHaveBeenCalled();
  });
});
