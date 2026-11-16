import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { TransactionRulesController } from "./transaction-rules.controller";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesMatchService } from "./transaction-rules-match.service";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { MatchDraftRuleDto, PreviewDraftRuleDto } from "./dto/rule-run.dto";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import { ExplainRuleRowDto } from "./dto/explain-rule-row.dto";
import { BadRequestException, ValidationPipe } from "@nestjs/common";

describe("TransactionRulesController", () => {
  let controller: TransactionRulesController;
  let service: Record<string, jest.Mock>;
  let runService: Record<string, jest.Mock>;
  let matchService: Record<string, jest.Mock>;
  const req = { user: { id: "user-1" } };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setEnabled: jest.fn(),
      remove: jest.fn(),
      reorder: jest.fn(),
    };
    runService = {
      previewRun: jest.fn(),
      previewDraft: jest.fn(),
      explainRow: jest.fn(),
      run: jest.fn(),
      applications: jest.fn(),
    };
    matchService = { matchDraft: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [TransactionRulesController],
      providers: [
        { provide: TransactionRulesService, useValue: service },
        { provide: TransactionRulesRunService, useValue: runService },
        { provide: TransactionRulesMatchService, useValue: matchService },
      ],
    }).compile();
    controller = module.get(TransactionRulesController);
  });

  it("previews a run for the JWT user with the filters only", async () => {
    runService.previewRun.mockResolvedValue({ matched: [] });
    const filters = { accountIds: [], limit: 5 };

    await controller.previewRun(req, "rule-1", filters);

    expect(runService.previewRun).toHaveBeenCalledWith(
      "user-1",
      "rule-1",
      filters,
    );
  });

  it("previews an unsaved draft for the JWT user", async () => {
    runService.previewDraft.mockResolvedValue({ matched: [] });
    const dto = { condition: {}, actions: [] };

    await controller.previewDraft(req, dto);

    expect(runService.previewDraft).toHaveBeenCalledWith("user-1", dto);
  });

  it("matches an unsaved condition for the JWT user", async () => {
    matchService.matchDraft.mockResolvedValue({ data: [] });
    const dto = { condition: {}, page: 2 } as MatchDraftRuleDto;

    await controller.matchDraft(req, dto);

    expect(matchService.matchDraft).toHaveBeenCalledWith("user-1", dto);
  });

  describe("match-draft body, through the app's validation pipe", () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const meta = { type: "body", metatype: MatchDraftRuleDto } as const;
    const condition = { field: "payeeText", op: "contains", value: "x" };

    it("lets a condition with a page and a window through, with no actions", async () => {
      await expect(
        pipe.transform(
          {
            condition,
            page: 2,
            limit: 10,
            activeFrom: "2026-10-01",
            activeTo: "",
          },
          meta,
        ),
      ).resolves.toMatchObject({ page: 2, limit: 10 });
    });

    it.each([
      ["a page size over the ceiling", { condition, limit: 51 }],
      ["a page below one", { condition, page: 0 }],
      [
        "a date that is not a calendar date",
        { condition, activeFrom: "2026-02-30" },
      ],
      ["a field the body does not take", { condition, actions: [] }],
      ["no condition", {}],
    ])("refuses %s", async (_label, body) => {
      await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it("explains a row for the JWT user, with the body the pipe validated", async () => {
    runService.explainRow.mockResolvedValue({ rules: [], labels: {} });
    const dto = {
      trigger: "import",
      input: { accountId: "a" },
    } as unknown as ExplainRuleRowDto;

    await expect(controller.explainRow(req, dto)).resolves.toEqual({
      rules: [],
      labels: {},
    });

    expect(runService.explainRow).toHaveBeenCalledWith("user-1", dto);
  });

  describe("explain-row body, through the app's validation pipe", () => {
    // The settings of main.ts: whitelist + forbidNonWhitelisted + transform.
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const meta = { type: "body", metatype: ExplainRuleRowDto } as const;
    const row = {
      accountId: "a0000000-0000-4000-8000-000000000001",
      currencyCode: "PLN",
      amount: "-1.0000",
      isTransfer: false,
      payeeId: null,
      payeeText: "Sklep",
      categoryId: null,
      description: null,
      tagIds: [],
      hasSplits: false,
    };

    it("lets a bounded row through", async () => {
      await expect(
        pipe.transform({ trigger: "import", input: row }, meta),
      ).resolves.toMatchObject({ trigger: "import" });
    });

    it("refuses an oversized row before the service is reached", async () => {
      const tooManyTags = Array.from(
        { length: 51 },
        (_v, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      for (const input of [
        { ...row, tagIds: tooManyTags },
        { ...row, payeeText: "x".repeat(256) },
        { ...row, description: "x".repeat(100000) },
        { ...row, userId: "a0000000-0000-4000-8000-000000000002" },
      ]) {
        await expect(
          pipe.transform({ trigger: "import", input }, meta),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(runService.explainRow).not.toHaveBeenCalled();
    });
  });

  it("forwards the ruleId of a saved rule's draft to the service untouched", async () => {
    runService.previewDraft.mockResolvedValue({ matched: [] });
    const dto = {
      ruleId: "e0000000-0000-4000-8000-000000000005",
      condition: {},
      actions: [],
    };

    await controller.previewDraft(req, dto);

    expect(runService.previewDraft).toHaveBeenCalledWith("user-1", dto);
  });

  it("validates ruleId as an optional UUID on the preview-draft body", async () => {
    const check = (body: object) =>
      validate(plainToInstance(PreviewDraftRuleDto, body));
    const base = { condition: {}, actions: [] };
    expect(await check(base)).toHaveLength(0);
    expect(
      await check({
        ...base,
        ruleId: "e0000000-0000-4000-8000-000000000005",
      }),
    ).toHaveLength(0);
    const bad = await check({ ...base, ruleId: "not-a-uuid" });
    expect(bad.map((e) => e.property)).toEqual(["ruleId"]);
  });

  it("runs a rule with the fingerprint of the preview", async () => {
    runService.run.mockResolvedValue({ changed: 1 });
    const dto = { fingerprint: "0".repeat(64), limit: 5 };

    await expect(controller.run(req, "rule-1", dto)).resolves.toEqual({
      changed: 1,
    });
    expect(runService.run).toHaveBeenCalledWith("user-1", "rule-1", dto);
  });

  it("reads the applications of a rule with the limit", async () => {
    runService.applications.mockResolvedValue([]);

    await controller.applications(req, "rule-1", 20);

    expect(runService.applications).toHaveBeenCalledWith(
      "user-1",
      "rule-1",
      20,
    );
  });

  it("lists with the JWT user", async () => {
    service.list.mockResolvedValue([{ id: "r1" }]);

    await expect(controller.findAll(req)).resolves.toEqual([{ id: "r1" }]);
    expect(service.list).toHaveBeenCalledWith("user-1");
  });

  it("gets one rule", async () => {
    service.get.mockResolvedValue({ id: "r1" });

    await expect(controller.findOne(req, "r1")).resolves.toEqual({ id: "r1" });
    expect(service.get).toHaveBeenCalledWith("user-1", "r1");
  });

  it("creates with the JWT user", async () => {
    const dto = { name: "n" } as CreateTransactionRuleDto;
    service.create.mockResolvedValue({ id: "r1" });

    await controller.create(req, dto);

    expect(service.create).toHaveBeenCalledWith("user-1", dto);
  });

  it("updates by id", async () => {
    const dto = { revision: 2 } as UpdateTransactionRuleDto;

    await controller.update(req, "r1", dto);

    expect(service.update).toHaveBeenCalledWith("user-1", "r1", dto);
  });

  it("toggles enabled", async () => {
    await controller.setEnabled(req, "r1", { enabled: false });

    expect(service.setEnabled).toHaveBeenCalledWith("user-1", "r1", false);
  });

  it("deletes by id", async () => {
    await controller.remove(req, "r1");

    expect(service.remove).toHaveBeenCalledWith("user-1", "r1");
  });

  it("reorders with the ids", async () => {
    await controller.reorder(req, { ids: ["r2", "r1"] });

    expect(service.reorder).toHaveBeenCalledWith("user-1", ["r2", "r1"]);
  });

  describe("route table", () => {
    const proto = TransactionRulesController.prototype;
    const route = (name: keyof TransactionRulesController) => ({
      path: Reflect.getMetadata(PATH_METADATA, proto[name]),
      method: Reflect.getMetadata(METHOD_METADATA, proto[name]),
    });

    it("maps the seven endpoints", () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, TransactionRulesController),
      ).toBe("transaction-rules");
      expect(route("findAll")).toEqual({
        path: "/",
        method: RequestMethod.GET,
      });
      expect(route("create")).toEqual({
        path: "/",
        method: RequestMethod.POST,
      });
      expect(route("reorder")).toEqual({
        path: "reorder",
        method: RequestMethod.PUT,
      });
      expect(route("findOne")).toEqual({
        path: ":id",
        method: RequestMethod.GET,
      });
      expect(route("update")).toEqual({
        path: ":id",
        method: RequestMethod.PATCH,
      });
      expect(route("setEnabled")).toEqual({
        path: ":id/enabled",
        method: RequestMethod.PATCH,
      });
      expect(route("previewDraft")).toEqual({
        path: "preview-draft",
        method: RequestMethod.POST,
      });
      expect(route("matchDraft")).toEqual({
        path: "match-draft",
        method: RequestMethod.POST,
      });
      expect(route("explainRow")).toEqual({
        path: "explain-row",
        method: RequestMethod.POST,
      });
      expect(route("previewRun")).toEqual({
        path: ":id/preview-run",
        method: RequestMethod.POST,
      });
      expect(route("run")).toEqual({
        path: ":id/run",
        method: RequestMethod.POST,
      });
      expect(route("applications")).toEqual({
        path: ":id/applications",
        method: RequestMethod.GET,
      });
      expect(route("remove")).toEqual({
        path: ":id",
        method: RequestMethod.DELETE,
      });
    });

    it("registers reorder before the :id routes so it is not read as a UUID", () => {
      const order = Object.getOwnPropertyNames(proto);
      expect(order.indexOf("reorder")).toBeLessThan(order.indexOf("findOne"));
    });

    it("registers preview-draft before the :id routes so it is not read as a UUID", () => {
      const order = Object.getOwnPropertyNames(proto);
      expect(order.indexOf("previewDraft")).toBeLessThan(
        order.indexOf("findOne"),
      );
    });

    it("registers match-draft before the :id routes so it is not read as a UUID", () => {
      const order = Object.getOwnPropertyNames(proto);
      expect(order.indexOf("matchDraft")).toBeLessThan(
        order.indexOf("findOne"),
      );
    });

    it("registers explain-row before the :id routes so it is not read as a UUID", () => {
      const order = Object.getOwnPropertyNames(proto);
      expect(order.indexOf("explainRow")).toBeLessThan(
        order.indexOf("findOne"),
      );
    });

    it("is under the JWT guard and refuses a delegate session", () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, TransactionRulesController),
      ).toHaveLength(1);
      // OwnerOnly() sets ALLOW_DELEGATE_KEY to false on the class, and no
      // method overrides it with @AllowDelegate().
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, TransactionRulesController),
      ).toBe(false);
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        expect(
          Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
        ).not.toBe(true);
      }
    });
  });
});
