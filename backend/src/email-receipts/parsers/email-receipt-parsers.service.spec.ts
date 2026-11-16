import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Category } from "../../categories/entities/category.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_CONTRACT_2,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_REPAYMENT_LINES,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "../parsing/fixtures/allegro-pay-mails";
import {
  dominantSenderDomain,
  EmailReceiptParsersService,
  MAX_PARSERS_PER_USER,
} from "./email-receipt-parsers.service";
import {
  RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION,
} from "./parser-draft-instruction";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const CAT_A = "11111111-1111-4111-8111-111111111111";
const CAT_B = "22222222-2222-4222-8222-222222222222";

const definition = (over: Record<string, unknown> = {}) => ({
  version: 2,
  total: ["Order total: {amount}"],
  defaultCategoryId: CAT_A,
  ...over,
});

const stored = (over: Partial<EmailReceiptParser> = {}): EmailReceiptParser =>
  Object.assign(new EmailReceiptParser(), {
    id: "p1",
    userId: USER,
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition: definition(),
    status: "draft",
    source: "manual",
    approvedAt: null,
    revision: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
    ...over,
  });

function setup() {
  const parserRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((v: Partial<EmailReceiptParser>) =>
      Object.assign(new EmailReceiptParser(), v),
    ),
    save: jest.fn(async (v: EmailReceiptParser) =>
      Object.assign(v, {
        id: "p-new",
        revision: 1,
        createdAt: new Date("2026-09-30T00:00:00Z"),
        updatedAt: new Date("2026-09-30T00:00:00Z"),
      }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const categoryRepo = {
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockImplementation(
      async ({ where }) =>
        // every id asked for is owned, unless a spec says otherwise
        (where.id._value as string[]).length,
    ),
  };
  const payeeRepo = {
    count: jest.fn().mockResolvedValue(1),
    findOne: jest.fn(),
  };
  const receiptRepo = { findOne: jest.fn(), count: jest.fn(), find: jest.fn() };
  const requests = {
    enqueueParserDraft: jest.fn(),
    markParserDraftApplied: jest.fn().mockResolvedValue(0),
    dismissParserDraftsFor: jest.fn().mockResolvedValue(0),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceiptParser, parserRepo],
    [Category, categoryRepo],
    [Payee, payeeRepo],
    [EmailReceipt, receiptRepo],
  ]);
  const service = new EmailReceiptParsersService(
    dataSource as never,
    requests as never,
  );
  return {
    service,
    manager,
    parserRepo,
    categoryRepo,
    payeeRepo,
    receiptRepo,
    requests,
  };
}

const createDto = (over: Record<string, unknown> = {}) =>
  ({
    name: "Shop",
    fromDomains: [
      "shop.example.com",
      "shop.example.com",
      "mail.shop.example.com",
    ],
    definition: definition(),
    ...over,
  }) as never;

describe("EmailReceiptParsersService.create", () => {
  it("saves a manual parser as approved, de-duplicating domains", async () => {
    const { service, parserRepo } = setup();
    const view = await service.create(USER, createDto());
    const saved = parserRepo.save.mock.calls[0][0] as EmailReceiptParser;
    expect(saved).toMatchObject({
      userId: USER,
      name: "Shop",
      status: "approved",
      source: "manual",
      fromDomains: ["shop.example.com", "mail.shop.example.com"],
      subjectContains: [],
    });
    expect(saved.approvedAt).toBeInstanceOf(Date);
    expect(view).toMatchObject({
      id: "p-new",
      status: "approved",
      definitionValid: true,
      definitionErrors: [],
    });
  });

  it("checks the user owns every category, in the write's transaction", async () => {
    const { service, categoryRepo, parserRepo, manager } = setup();
    await service.create(
      USER,
      createDto({
        definition: definition({
          categoryRules: [{ match: "*x*", categoryId: CAT_B }],
        }),
      }),
    );
    const where = categoryRepo.count.mock.calls[0][0].where;
    expect(where.userId).toBe(USER);
    expect(where.id._value).toEqual([CAT_B, CAT_A]);
    // checked before the write, inside the same transaction
    expect(categoryRepo.count.mock.invocationCallOrder[0]).toBeLessThan(
      parserRepo.save.mock.invocationCallOrder[0],
    );
    expect(manager.getRepository).toHaveBeenCalled();
  });

  it("refuses a category that is not the user's and writes nothing", async () => {
    const { service, categoryRepo, parserRepo } = setup();
    categoryRepo.count.mockResolvedValue(0);
    await expect(service.create(USER, createDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("refuses a payee that is not the user's and writes nothing", async () => {
    const { service, payeeRepo, parserRepo } = setup();
    payeeRepo.count.mockResolvedValue(0);
    await expect(
      service.create(USER, createDto({ payeeId: "payee-x" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(payeeRepo.count).toHaveBeenCalledWith({
      where: { id: "payee-x", userId: USER },
    });
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("lists every code of an invalid definition in the 400, and writes nothing", async () => {
    const { service, parserRepo } = setup();
    const error = await service
      .create(
        USER,
        createDto({
          definition: { version: 2, total: ["no capture"], bogus: 1 },
        }),
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("bogus: unknown_key");
    expect(error.message).toContain("total[0]: capture_missing");
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("reports a definition restored as {} as invalid rather than crashing", async () => {
    const { service } = setup();
    const error = await service
      .create(USER, createDto({ definition: {} }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("version: unsupported_version");
  });

  it("refuses beyond the cap", async () => {
    const { service, parserRepo } = setup();
    parserRepo.count.mockResolvedValue(MAX_PARSERS_PER_USER);
    await expect(service.create(USER, createDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(parserRepo.save).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptParsersService reads", () => {
  it("lists the user's parsers, flagging a {} definition as invalid", async () => {
    const { service, parserRepo } = setup();
    parserRepo.find.mockResolvedValue([
      stored(),
      stored({ id: "p2", definition: {} }),
    ]);
    const views = await service.list(USER);
    expect(parserRepo.find.mock.calls[0][0].where).toEqual({ userId: USER });
    expect(views.map((v) => v.definitionValid)).toEqual([true, false]);
    expect(views[1].definitionErrors.map((e) => e.code)).toContain(
      "unsupported_version",
    );
  });

  it("gets one, or 404s for a parser that is not the user's", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValueOnce(stored());
    await expect(service.get(USER, "p1")).resolves.toMatchObject({ id: "p1" });
    expect(parserRepo.findOne).toHaveBeenCalledWith({
      where: { id: "p1", userId: USER },
    });
    parserRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.get(USER, "p1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptParsersService reprocessableCount", () => {
  it("adds the count of emails to read again to each parser, from ONE statement for the whole list", async () => {
    const { service, manager, parserRepo } = setup();
    parserRepo.find.mockResolvedValue([
      stored({ id: "p1", status: "approved" }),
      stored({ id: "p2", status: "approved" }),
      stored({ id: "p3", status: "draft" }),
    ]);
    manager.query.mockResolvedValue([{ id: "p1", n: "7" }]);

    const views = await service.list(USER);

    expect(views.map((v) => [v.id, v.reprocessableCount])).toEqual([
      ["p1", 7],
      ["p2", 0],
      ["p3", 0],
    ]);
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    // approved parsers only; processable statuses; processed before the parser's last change
    expect(sql).toContain("p.status = 'approved'");
    expect(sql).toContain("r.updated_at < p.updated_at");
    expect(sql).toContain("r.status = ANY($2::varchar[])");
    // the pipeline's sub-domain rule
    expect(sql).toContain("right(r.from_domain, length(pd.domain) + 1)");
    expect(sql).toContain("p.user_id = $1");
    expect(sql).toContain("r.user_id = p.user_id");
    // a component profile also counts the applied review emails it covers (spec 9)
    expect(sql).toContain("p.definition->>'role' = 'component'");
    expect(sql).toContain("r.link_key IS NULL");
    expect(sql).toContain("applied_rq.status = 'applied'");
    expect(params).toEqual([
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
    ]);
  });

  it("counts for the one parser a get, create, update or approve answers with", async () => {
    const { service, manager, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(
      stored({ id: "p1", status: "approved" }),
    );
    manager.query.mockResolvedValue([{ id: "p1", n: 2 }]);

    const view = await service.get(USER, "p1");

    expect(view.reprocessableCount).toBe(2);
    expect(manager.query.mock.calls[0][1][2]).toEqual(["p1"]);
  });

  it("is 0 for a parser with no emails to read again", async () => {
    const { service, manager, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ status: "approved" }));
    manager.query.mockResolvedValue([]);
    await expect(service.get(USER, "p1")).resolves.toMatchObject({
      reprocessableCount: 0,
    });
  });
});

describe("EmailReceiptParsersService.update", () => {
  const dto = (over: Record<string, unknown> = {}) =>
    ({ expectedRevision: 3, ...over }) as never;

  it("changes what was sent under the row lock and bumps the revision", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    parserRepo.findOneByOrFail.mockResolvedValue(
      stored({ revision: 4, name: "New" }),
    );

    const view = await service.update(
      USER,
      "p1",
      dto({
        name: "New",
        definition: definition({ shipping: ["Shipping: {amount}"] }),
      }),
    );

    expect(parserRepo.findOne).toHaveBeenCalledWith({
      where: { id: "p1", userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    const [where, patch] = parserRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "p1", userId: USER });
    expect(patch.name).toBe("New");
    expect(patch.definition).toMatchObject({
      shipping: ["Shipping: {amount}"],
    });
    expect(patch.revision()).toBe("revision + 1");
    expect(patch).not.toHaveProperty("fromDomains");
    expect(patch).not.toHaveProperty("status");
    expect(view.revision).toBe(4);
  });

  it("is a 409 when the parser moved on, and writes nothing", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ revision: 5 }));
    await expect(
      service.update(USER, "p1", dto({ name: "New" })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("is a 404 for a missing parser, before any revision talk", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(null);
    await expect(service.update(USER, "p1", dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("validates a new definition and refuses a bad one before writing", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    await expect(
      service.update(USER, "p1", dto({ definition: {} })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("checks a new payee and new categories are the user's, and writes nothing otherwise", async () => {
    const { service, parserRepo, payeeRepo, categoryRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    payeeRepo.count.mockResolvedValue(0);
    await expect(
      service.update(USER, "p1", dto({ payeeId: "payee-x" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    payeeRepo.count.mockResolvedValue(1);
    categoryRepo.count.mockResolvedValue(0);
    await expect(
      service.update(USER, "p1", dto({ definition: definition() })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("does not re-check a payee that did not change, and can clear it", async () => {
    const { service, parserRepo, payeeRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ payeeId: "payee-1" }));
    parserRepo.findOneByOrFail.mockResolvedValue(stored());
    await service.update(USER, "p1", dto({ payeeId: "payee-1" }));
    expect(payeeRepo.count).not.toHaveBeenCalled();
    await service.update(USER, "p1", dto({ payeeId: null }));
    expect(parserRepo.update.mock.calls[1][1].payeeId).toBeNull();
  });
});

describe("EmailReceiptParsersService.approve", () => {
  it("approves a valid draft, stamping the time and bumping the revision", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    parserRepo.findOneByOrFail.mockResolvedValue(
      stored({ status: "approved", revision: 4, approvedAt: new Date() }),
    );
    const view = await service.approve(USER, "p1");
    const [, patch] = parserRepo.update.mock.calls[0];
    expect(patch.status).toBe("approved");
    expect(patch.approvedAt).toBeInstanceOf(Date);
    expect(patch.revision()).toBe("revision + 1");
    expect(view.status).toBe("approved");
  });

  it("marks the parser-draft request that proposed it applied, in the approving transaction", async () => {
    const { service, parserRepo, requests, manager } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    parserRepo.findOneByOrFail.mockResolvedValue(
      stored({ status: "approved", revision: 4 }),
    );

    await service.approve(USER, "p1");

    expect(requests.markParserDraftApplied).toHaveBeenCalledWith(
      manager,
      USER,
      "p1",
    );
    // after the status UPDATE, before the row is read back
    expect(parserRepo.update.mock.invocationCallOrder[0]).toBeLessThan(
      requests.markParserDraftApplied.mock.invocationCallOrder[0],
    );
  });

  it("does not touch a request when the approval is refused or a no-op", async () => {
    const { service, parserRepo, requests, categoryRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ status: "approved" }));
    await service.approve(USER, "p1");
    parserRepo.findOne.mockResolvedValue(stored({ definition: {} }));
    await service.approve(USER, "p1").catch(() => undefined);
    parserRepo.findOne.mockResolvedValue(stored());
    categoryRepo.count.mockResolvedValue(0);
    await service.approve(USER, "p1").catch(() => undefined);
    parserRepo.findOne.mockResolvedValue(stored({ revision: 9 }));
    await service
      .approve(USER, "p1", { expectedRevision: 3 })
      .catch(() => undefined);

    expect(requests.markParserDraftApplied).not.toHaveBeenCalled();
  });

  it("refuses to approve a definition that is not valid (a {} restored from a backup)", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ definition: {} }));
    const error = await service.approve(USER, "p1").catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("unsupported_version");
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("refuses a draft whose category is gone since it was written", async () => {
    const { service, parserRepo, categoryRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored());
    categoryRepo.count.mockResolvedValue(0);
    await expect(service.approve(USER, "p1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("is a 409 when the approval was of another revision", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ revision: 5 }));
    await expect(
      service.approve(USER, "p1", { expectedRevision: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(parserRepo.update).not.toHaveBeenCalled();
  });

  it("approving an approved parser changes nothing", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(stored({ status: "approved" }));
    const view = await service.approve(USER, "p1");
    expect(parserRepo.update).not.toHaveBeenCalled();
    expect(view.status).toBe("approved");
  });

  it("is a 404 for a parser that is not the user's", async () => {
    const { service, parserRepo } = setup();
    parserRepo.findOne.mockResolvedValue(null);
    await expect(service.approve(USER, "p1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("EmailReceiptParsersService.remove", () => {
  it("deletes by id and owner, or 404s", async () => {
    const { service, parserRepo } = setup();
    await service.remove(USER, "p1");
    expect(parserRepo.delete).toHaveBeenCalledWith({ id: "p1", userId: USER });
    parserRepo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove(USER, "p1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("dismisses the parser-draft requests that proposed it, in the same transaction", async () => {
    const { service, requests, manager } = setup();
    await service.remove(USER, "p1");
    expect(requests.dismissParserDraftsFor).toHaveBeenCalledWith(
      manager,
      USER,
      "p1",
    );
  });

  it("dismisses nothing for a parser that was not there", async () => {
    const { service, parserRepo, requests } = setup();
    parserRepo.delete.mockResolvedValue({ affected: 0 });
    await service.remove(USER, "p1").catch(() => undefined);
    expect(requests.dismissParserDraftsFor).not.toHaveBeenCalled();
  });
});

describe("dominantSenderDomain", () => {
  it("is the most common non-empty domain, the first one winning a tie", () => {
    expect(dominantSenderDomain(["a.example", "b.example", "b.example"])).toBe(
      "b.example",
    );
    expect(dominantSenderDomain(["a.example", "b.example"])).toBe("a.example");
    expect(dominantSenderDomain(["", "b.example"])).toBe("b.example");
    expect(dominantSenderDomain(["", ""])).toBe("");
    expect(dominantSenderDomain([])).toBe("");
  });
});

describe("EmailReceiptParsersService.requestAiDraft", () => {
  const R1 = "00000000-0000-4000-8000-000000000001";
  const R2 = "00000000-0000-4000-8000-000000000002";
  const row = (id: string, fromDomain: string, status = "no_parser") => ({
    id,
    fromDomain,
    status,
  });

  it("queues one pending request for the emails, filed under their sender, and calls no provider", async () => {
    const { service, receiptRepo, requests, manager } = setup();
    receiptRepo.find.mockResolvedValue([
      row(R1, "shop.example.com"),
      row(R2, "shop.example.com"),
    ]);
    requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });

    const result = await service.requestAiDraft(USER, [R2, R1]);

    expect(result).toEqual({ ok: true, requestId: "req-1" });
    expect(requests.enqueueParserDraft).toHaveBeenCalledWith(manager, USER, {
      emailReceiptIds: [R2, R1],
      parserDomain: "shop.example.com",
      instruction: RECEIPT_PARSER_DRAFT_INSTRUCTION,
    });
    // the emails are read through the user's own scope
    expect(receiptRepo.find.mock.calls[0][0].where.userId).toBe(USER);
  });

  it("asks for a trade profile when the emails are trade confirmations", async () => {
    const { service, receiptRepo, requests } = setup();
    receiptRepo.find.mockResolvedValue([row(R1, "broker.example.com")]);
    requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });

    await service.requestAiDraft(USER, [R1], "trade");

    const { instruction } = requests.enqueueParserDraft.mock.calls[0][2];
    expect(instruction).toBe(RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION);
    expect(instruction.length).toBeLessThanOrEqual(1000);
    expect(instruction).toContain("accountRules");
  });

  it("files a mixed selection under the most common sender", async () => {
    const { service, receiptRepo, requests } = setup();
    receiptRepo.find.mockResolvedValue([
      row(R1, "a.example.com"),
      row(R2, "b.example.com"),
      row("r3", "b.example.com"),
    ]);
    requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });

    await service.requestAiDraft(USER, [R1, R2, "r3"]);

    expect(requests.enqueueParserDraft.mock.calls[0][2].parserDomain).toBe(
      "b.example.com",
    );
  });

  describe("the sender limits of a selection (spec 10a)", () => {
    const many = (domain: string, n: number, from = 0) =>
      Array.from({ length: n }, (_, i) =>
        row(`r-${domain}-${from + i}`, domain),
      );
    const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

    it("takes five emails of each of five domains (25 in all), with the multi-sender instruction", async () => {
      const { service, receiptRepo, requests } = setup();
      const rows = [1, 2, 3, 4, 5].flatMap((d) => many(`d${d}.example.com`, 5));
      receiptRepo.find.mockResolvedValue(rows);
      requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });

      await service.requestAiDraft(USER, idsOf(rows));

      const input = requests.enqueueParserDraft.mock.calls[0][2];
      expect(input.instruction).toBe(
        RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
      );
      expect(input.emailReceiptIds).toHaveLength(25);
    });

    it("uses the one-sender instruction for one domain and the multi-sender one for two", async () => {
      const { service, receiptRepo, requests } = setup();
      requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });
      const one = many("a.example.com", 5);
      receiptRepo.find.mockResolvedValue(one);
      await service.requestAiDraft(USER, idsOf(one));
      expect(requests.enqueueParserDraft.mock.calls[0][2].instruction).toBe(
        RECEIPT_PARSER_DRAFT_INSTRUCTION,
      );
      const two = [...many("a.example.com", 5), ...many("b.example.com", 1)];
      receiptRepo.find.mockResolvedValue(two);
      await service.requestAiDraft(USER, idsOf(two));
      expect(requests.enqueueParserDraft.mock.calls[1][2].instruction).toBe(
        RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
      );
    });

    it("refuses more than five domains with a 400 naming the limit, writing nothing", async () => {
      const { service, receiptRepo, requests } = setup();
      const rows = [1, 2, 3, 4, 5, 6].flatMap((d) =>
        many(`d${d}.example.com`, 1),
      );
      receiptRepo.find.mockResolvedValue(rows);

      const error = await service
        .requestAiDraft(USER, idsOf(rows))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(
        "Select emails from at most 5 senders.",
      );
      expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
    });

    it("refuses more than five emails of one domain, even beside another domain", async () => {
      const { service, receiptRepo, requests } = setup();
      const rows = [...many("a.example.com", 6), ...many("b.example.com", 1)];
      receiptRepo.find.mockResolvedValue(rows);

      const error = await service
        .requestAiDraft(USER, idsOf(rows))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(
        "Select at most 5 emails from one sender.",
      );
      expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
    });

    it("refuses a trade draft of two domains, and still takes five of one", async () => {
      const { service, receiptRepo, requests } = setup();
      requests.enqueueParserDraft.mockResolvedValue({ id: "req-1" });
      const two = [...many("a.example.com", 1), ...many("b.example.com", 1)];
      receiptRepo.find.mockResolvedValue(two);

      const error = await service
        .requestAiDraft(USER, idsOf(two), "trade")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toMatch(/one sender/);
      expect(requests.enqueueParserDraft).not.toHaveBeenCalled();

      const one = many("a.example.com", 5);
      receiptRepo.find.mockResolvedValue(one);
      await service.requestAiDraft(USER, idsOf(one), "trade");
      expect(requests.enqueueParserDraft.mock.calls[0][2].instruction).toBe(
        RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION,
      );
    });

    it("refuses a selection when one of its domains is not usable", async () => {
      const { service, receiptRepo, requests } = setup();
      const rows = [...many("a.example.com", 2), row("r-x", "localhost")];
      receiptRepo.find.mockResolvedValue(rows);

      await expect(
        service.requestAiDraft(USER, idsOf(rows)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
    });
  });

  it("is a 404 for an email that is not the user's, and writes nothing", async () => {
    const { service, receiptRepo, requests } = setup();
    receiptRepo.find.mockResolvedValue([row(R1, "shop.example.com")]);

    await expect(service.requestAiDraft(USER, [R1, R2])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
  });

  it("refuses a skipped email (it has no text), and writes nothing", async () => {
    const { service, receiptRepo, requests } = setup();
    receiptRepo.find.mockResolvedValue([
      row(R1, "shop.example.com"),
      row(R2, "", "skipped"),
    ]);

    await expect(service.requestAiDraft(USER, [R1, R2])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
  });

  it("refuses a selection with no usable sender domain", async () => {
    const { service, receiptRepo, requests } = setup();
    receiptRepo.find.mockResolvedValue([row(R1, "")]);

    await expect(service.requestAiDraft(USER, [R1])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    receiptRepo.find.mockResolvedValue([row(R1, "localhost")]);
    await expect(service.requestAiDraft(USER, [R1])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(requests.enqueueParserDraft).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptParsersService.test", () => {
  const receipt = Object.assign(new EmailReceipt(), {
    id: "r1",
    userId: USER,
    subject: "Order #ABCD1234",
    bodyText: "Order number: ABCD1234\nOrder total: 37.97",
    receivedAt: new Date("2026-09-10T10:00:00Z"),
  });
  const testDto = (over: Record<string, unknown> = {}) =>
    ({
      receiptId: "r1",
      definition: {
        version: 2,
        orderId: ["Order number: {orderid}"],
        total: ["Order total: {amount}"],
      },
      ...over,
    }) as never;

  it("reads the stored email and previews the match, writing nothing", async () => {
    const { service, manager, receiptRepo, parserRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(receipt);
    manager.query.mockResolvedValue([
      {
        id: "t1",
        transaction_date: "2026-09-11",
        amount: "-37.9700",
        payee_id: null,
        payee_name: "Shop",
        description: "Order ABCD1234",
        reference_number: null,
      },
    ]);

    const result = await service.test(USER, testDto());

    expect(result.parsed).toMatchObject({ orderId: "ABCD1234", total: 379700 });
    expect(result.outcome).toBe("read");
    expect(result.trace.total).toEqual({
      entry: 0,
      pattern: "Order total: {amount}",
      line: { line: 2, text: "Order total: 37.97" },
    });
    expect(result.match).toMatchObject({
      kind: "matched",
      transactionId: "t1",
      matchKind: "order_id",
      strategy: "orderId",
    });
    // What the matcher looked at: the default window and strategies, and what
    // the deciding strategy kept (design 5.5).
    expect(result.matchTrace).toMatchObject({
      window: { from: "2026-09-07", to: "2026-09-24" },
      by: ["orderId", "amount_payee", "amount_date"],
      considered: 1,
      decidedBy: "orderId",
      attempts: [
        {
          strategy: "orderId",
          count: 1,
          transactions: [
            { id: "t1", date: "2026-09-11", amount: -37.97, payeeName: "Shop" },
          ],
        },
      ],
    });
    expect(result.candidateCount).toBe(1);
    expect(result.transaction).toEqual({
      id: "t1",
      date: "2026-09-11",
      amount: -37.97,
      payeeName: "Shop",
    });
    expect(parserRepo.save).not.toHaveBeenCalled();
    expect(parserRepo.update).not.toHaveBeenCalled();
    // every statement it ran is a read
    for (const [sql] of manager.query.mock.calls) {
      expect(String(sql).trim()).toMatch(/^SELECT/);
    }
  });

  describe("componentDrafts", () => {
    const componentDefinition = {
      version: 2,
      role: "component",
      linkKey: ["Contract {link}"],
      total: ["Order total: {amount}"],
    };
    const settlement = {
      version: 2,
      role: "settlement",
      paid: ["Paid {amount}"],
    };

    it("refuses drafts beside a definition that is not a settlement, with the code, before any read", async () => {
      const { service, receiptRepo } = setup();
      receiptRepo.findOne.mockResolvedValue(receipt);

      const error = await service
        .test(
          USER,
          testDto({
            componentDrafts: [
              {
                definition: componentDefinition,
                fromDomains: ["shop.example.com"],
              },
            ],
          }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain(
        "component_draft_requires_settlement",
      );
    });

    it("refuses a draft that is not a component and one with a bad domain", async () => {
      const { service, receiptRepo } = setup();
      receiptRepo.findOne.mockResolvedValue(receipt);

      const notComponent = await service
        .test(
          USER,
          testDto({
            definition: settlement,
            componentDrafts: [
              { definition: settlement, fromDomains: ["shop.example.com"] },
            ],
          }),
        )
        .catch((e: unknown) => e);
      expect((notComponent as Error).message).toContain(
        "component_draft_requires_component",
      );
      const badDomain = await service
        .test(
          USER,
          testDto({
            definition: settlement,
            componentDrafts: [
              { definition: componentDefinition, fromDomains: ["nope"] },
            ],
          }),
        )
        .catch((e: unknown) => e);
      expect((badDomain as Error).message).toContain(
        "component_draft_domain_invalid",
      );
    });
  });

  describe("the lines source", () => {
    const html =
      "<table><tr><td>Order number:</td><td>HTML-7777</td></tr>" +
      "<tr><td>Wrapped product name that the text splits</td><td>12,00 zł</td></tr>" +
      "<tr><td>Razem</td><td>12,00 zł</td></tr></table>";
    const htmlDefinition = (source?: string) => ({
      version: 2,
      ...(source === undefined ? {} : { source }),
      orderId: [{ label: "Order number:", value: "{orderid}" }],
      total: [{ label: "Razem", value: "{amount} zł" }],
    });

    it("reads the HTML lines for source html, and the trace numbers those lines", async () => {
      const { service, manager, receiptRepo } = setup();
      receiptRepo.findOne.mockResolvedValue(
        Object.assign(new EmailReceipt(), receipt, { bodyHtml: html }),
      );
      manager.query.mockResolvedValue([]);
      const result = await service.test(
        USER,
        testDto({ definition: htmlDefinition("html") }),
      );
      expect(result.outcome).toBe("read");
      expect(result.parsed).toMatchObject({
        orderId: "HTML-7777",
        total: 120000,
      });
      expect(result.trace.total?.labelLine).toEqual({
        line: 5,
        text: "Razem",
      });
      expect(result.trace.total?.line).toEqual({ line: 6, text: "12,00 zł" });
    });

    it("reads the text for source text and for none, even when the email has HTML", async () => {
      const { service, manager, receiptRepo } = setup();
      receiptRepo.findOne.mockResolvedValue(
        Object.assign(new EmailReceipt(), receipt, { bodyHtml: html }),
      );
      manager.query.mockResolvedValue([]);
      for (const source of [undefined, "text"]) {
        const result = await service.test(
          USER,
          testDto({
            definition: {
              version: 2,
              ...(source === undefined ? {} : { source }),
              total: ["Order total: {amount}"],
            },
          }),
        );
        expect(result.parsed.total).toBe(379700);
        expect(result.trace.total?.line).toEqual({
          line: 2,
          text: "Order total: 37.97",
        });
      }
    });

    it("says no_html, and reads nothing, for source html on an email with no HTML part", async () => {
      const { service, manager, receiptRepo } = setup();
      receiptRepo.findOne.mockResolvedValue(
        Object.assign(new EmailReceipt(), receipt, { bodyHtml: null }),
      );
      manager.query.mockResolvedValue([]);
      const result = await service.test(
        USER,
        testDto({ definition: htmlDefinition("html") }),
      );
      expect(result.outcome).toBe("no_html");
      expect(result.parsed).toMatchObject({
        total: null,
        complete: false,
        reason: "no_total",
      });
      expect(result.trace.total).toBeNull();
      expect(result.trace.items).toEqual([]);
    });

    it("refuses an unknown source with the validator's code, before any read", async () => {
      const { service, manager } = setup();
      const error = await service
        .test(USER, testDto({ definition: htmlDefinition("pdf") }))
        .catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain("source");
      expect(manager.getRepository).not.toHaveBeenCalled();
    });
  });

  it("uses the payee's default category as the fallback and as a match signal", async () => {
    const { service, manager, receiptRepo, payeeRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(
      Object.assign(new EmailReceipt(), receipt, {
        bodyText: "Order total: 9.99\nItem: Widget 9.99",
      }),
    );
    payeeRepo.findOne.mockResolvedValue({
      id: "pay1",
      defaultCategoryId: CAT_A,
    });
    manager.query.mockResolvedValue([]);
    const result = await service.test(
      USER,
      testDto({
        payeeId: "pay1",
        definition: {
          version: 2,
          total: ["Order total: {amount}"],
          items: { patterns: ["Item: {name} {amount}"] },
        },
      }),
    );
    expect(result.parsed.items[0]).toMatchObject({ categoryId: CAT_A });
    expect(result.match).toMatchObject({ kind: "unmatched" });
    expect(result.transaction).toBeNull();
  });

  it("matches with the definition's own match section: its strategy, tolerance and window", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(receipt);
    manager.query.mockResolvedValue([
      {
        id: "t9",
        transaction_date: "2026-10-05",
        amount: "-38.2000",
        payee_id: null,
        payee_name: "Bank",
        description: "no order number here",
        reference_number: null,
      },
    ]);

    const result = await service.test(
      USER,
      testDto({
        definition: {
          version: 2,
          total: ["Order total: {amount}"],
          match: {
            by: ["amount_date"],
            daysBefore: 0,
            daysAfter: 30,
            amountTolerance: "0.25",
          },
        },
      }),
    );

    // The candidate query was given the profile's window (purchase 2026-09-10).
    const params = manager.query.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe("2026-09-10");
    expect(params[2]).toBe("2026-10-10");
    expect(result.match).toMatchObject({
      kind: "matched",
      transactionId: "t9",
      matchKind: "amount_date",
    });
    expect(result.matchTrace).toMatchObject({
      daysBefore: 0,
      daysAfter: 30,
      toleranceUnits: 2500,
      decidedBy: "amount_date",
    });
  });

  it("is a 404 for an email or a payee that is not the user's", async () => {
    const { service, receiptRepo, payeeRepo, manager } = setup();
    receiptRepo.findOne.mockResolvedValue(null);
    await expect(service.test(USER, testDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    receiptRepo.findOne.mockResolvedValue(receipt);
    payeeRepo.findOne.mockResolvedValue(null);
    await expect(
      service.test(USER, testDto({ payeeId: "nope" })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("is a 400 listing the codes for an invalid draft definition, before any read", async () => {
    const { service, manager } = setup();
    const error = await service
      .test(USER, testDto({ definition: {} }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("unsupported_version");
    expect(manager.getRepository).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptParsersService.test of linked receipts", () => {
  const receiptOf = (lines: string[], id: string) =>
    Object.assign(new EmailReceipt(), {
      id,
      userId: USER,
      subject: "Subject",
      bodyText: lines.join("\n"),
      receivedAt: new Date("2026-01-10T10:00:00Z"),
    });

  it("returns a component's link value and waiting settlements, with the empty match", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(
      receiptOf(ALLEGRO_PAY_PURCHASE_LINES, "c1"),
    );
    manager.query.mockResolvedValue([
      { id: "s1", subject: "Repayment", effective_date: "2026-01-10" },
    ]);

    const result = await service.test(USER, {
      receiptId: "c1",
      definition: ALLEGRO_PAY_COMPONENT_DEFINITION,
    } as never);

    expect(result.component).toEqual({
      linkKey: ALLEGRO_PAY_CONTRACT_2,
      waitingSettlements: [
        { id: "s1", subject: "Repayment", effectiveDate: "2026-01-10" },
      ],
    });
    expect(result.links).toBeUndefined();
    expect(result.match).toEqual({
      kind: "unmatched",
      considered: 0,
      attempts: [],
    });
    expect(result.candidateCount).toBe(0);
    expect(result.transaction).toBeNull();
  });

  it("returns a settlement's links per part and the joined reading", async () => {
    const { service, manager, receiptRepo } = setup();
    receiptRepo.findOne.mockResolvedValue(
      receiptOf(ALLEGRO_PAY_REPAYMENT_LINES, "s1"),
    );
    manager.query.mockResolvedValue([]);

    const result = await service.test(USER, {
      receiptId: "s1",
      definition: ALLEGRO_PAY_SETTLEMENT_DEFINITION,
    } as never);

    expect(result.component).toBeUndefined();
    expect(result.links?.map((link) => link.outcome)).toEqual([
      "not_found",
      "not_found",
    ]);
    expect(result.parsed.links).toHaveLength(2);
    expect(result.parsed.items).toHaveLength(2);
  });
});

describe("category names in a profile", () => {
  const categories = [
    { id: CAT_A, name: "Groceries", parentId: null },
    { id: CAT_B, name: "Fees", parentId: null },
  ];

  it("stores the ids of the named categories (case-insensitive) and shows names and the effective match", async () => {
    const { service, parserRepo, categoryRepo } = setup();
    categoryRepo.find.mockResolvedValue(categories);
    const view = await service.create(
      USER,
      createDto({
        definition: {
          version: 2,
          total: ["Order total: {amount}"],
          defaultCategory: "groceries",
          feesCategory: "FEES",
        },
      }),
    );
    const saved = parserRepo.save.mock.calls[0][0] as EmailReceiptParser;
    expect(saved.definition).toMatchObject({
      defaultCategoryId: CAT_A,
      feesCategoryId: CAT_B,
    });
    expect(saved.definition).not.toHaveProperty("defaultCategory");
    expect(saved.definition).not.toHaveProperty("feesCategory");
    expect(view.definition).toMatchObject({
      defaultCategory: "Groceries",
      feesCategory: "Fees",
      match: {
        by: ["orderId", "amount_payee", "amount_date"],
        daysBefore: 3,
        daysAfter: 14,
        amountTolerance: "0.00",
      },
    });
    expect(view.definition).not.toHaveProperty("defaultCategoryId");
    expect(view.definition).not.toHaveProperty("feesCategoryId");
  });

  it("refuses an unknown category name with a readable 400 and writes nothing", async () => {
    const { service, parserRepo, categoryRepo } = setup();
    categoryRepo.find.mockResolvedValue(categories);
    const error = await service
      .create(
        USER,
        createDto({
          definition: {
            version: 2,
            total: ["Order total: {amount}"],
            shippingCategory: "Nope",
          },
        }),
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain("Nope");
    expect(parserRepo.save).not.toHaveBeenCalled();
  });

  it("leads the effective match with reference when the profile reads a reference field", async () => {
    const { service, parserRepo, categoryRepo } = setup();
    categoryRepo.find.mockResolvedValue(categories);
    parserRepo.find.mockResolvedValue([
      stored({
        definition: definition({ reference: ["Ref: {reference}"] }),
      }),
    ]);
    const [view] = await service.list(USER);
    expect((view.definition.match as { by: string[] }).by).toEqual([
      "reference",
      "orderId",
      "amount_payee",
      "amount_date",
    ]);
    expect(view.definition.defaultCategory).toBe("Groceries");
  });
});
