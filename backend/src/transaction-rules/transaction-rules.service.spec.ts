import { LockScope } from "../common/db/locks";
import { BadRequestException } from "@nestjs/common";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { MAX_TRANSACTION_RULES_PER_USER } from "./transaction-rules.limits";
import {
  CATEGORY_ID,
  FOREIGN_ID,
  PAYEE_ID,
  RULE_ID,
  TAG_ID,
  USER_ID,
  VALID_ACTIONS,
  VALID_CONDITION,
  buildHarness,
  thrown,
} from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

function createDto(
  over: Partial<CreateTransactionRuleDto> = {},
): CreateTransactionRuleDto {
  return {
    name: "Groceries",
    triggers: ["create", "import"],
    condition: VALID_CONDITION as never,
    actions: VALID_ACTIONS as never,
    ...over,
  };
}

describe("TransactionRulesService create", () => {
  it("locks the rule list first, then appends at max + 1", async () => {
    const h = buildHarness();
    h.rawMax.mockResolvedValue({ max: 4 });

    const result = await h.service.create(USER_ID, createDto());

    expect(String(h.manager.query.mock.calls[0][0])).toContain(
      "pg_advisory_xact_lock",
    );
    expect(h.manager.query.mock.calls[0][1]).toEqual([
      LockScope.TransactionRules,
      USER_ID,
    ]);
    expect(h.rules.count.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.manager.query.mock.invocationCallOrder[0],
    );
    expect(h.rules.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        position: 5,
        enabled: true,
        stopProcessing: false,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ id: RULE_ID, invalid: false, position: 5 }),
    );
    expect(result.invalidReasons).toEqual([]);
  });

  it("puts the first rule at position 0", async () => {
    const h = buildHarness();
    h.rawMax.mockResolvedValue({ max: null });

    await h.service.create(USER_ID, createDto());

    expect(h.rules.save).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0 }),
    );
  });

  it("defaults onlyIfEmpty to true before validating and stores it", async () => {
    const h = buildHarness();

    await h.service.create(
      USER_ID,
      createDto({
        actions: [
          { type: "set_category", categoryId: CATEGORY_ID },
          { type: "set_payee", payeeId: PAYEE_ID, onlyIfEmpty: false },
        ],
      }),
    );

    expect(h.rules.save).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          { type: "set_category", categoryId: CATEGORY_ID, onlyIfEmpty: true },
          { type: "set_payee", payeeId: PAYEE_ID, onlyIfEmpty: false },
        ],
      }),
    );
  });

  it("refuses the 201st rule and writes nothing", async () => {
    const h = buildHarness();
    h.rules.count.mockResolvedValue(MAX_TRANSACTION_RULES_PER_USER);

    const error = await thrown(h.service.create(USER_ID, createDto()));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ errorCode: "RULE_LIMIT_REACHED" }),
    );
    expect(h.writes()).toEqual([]);
  });

  it("accepts the 200th rule", async () => {
    const h = buildHarness();
    h.rules.count.mockResolvedValue(MAX_TRANSACTION_RULES_PER_USER - 1);

    await expect(h.service.create(USER_ID, createDto())).resolves.toBeDefined();
  });

  it("refuses a new rule whose matches pattern is a bare word, at authoring", async () => {
    const h = buildHarness();

    const error = await thrown(
      h.service.create(
        USER_ID,
        createDto({
          condition: {
            all: [
              { field: "description", op: "matches", value: "NETFLIX.COM" },
            ],
          } as never,
        }),
      ),
    );

    expect(error.getResponse().errors).toEqual([
      { path: "condition.all[0].value", code: "PATTERN_WITHOUT_WILDCARD" },
    ]);
    expect(h.writes()).toEqual([]);
  });

  it("refuses an invalid definition with the structured errors and writes nothing", async () => {
    const h = buildHarness();

    const error = await thrown(
      h.service.create(USER_ID, createDto({ condition: {}, actions: [] })),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    const body = error.getResponse();
    expect(body.errorCode).toBe("INVALID_RULE");
    expect(body.errors).toEqual(
      expect.arrayContaining([
        { path: "condition", code: "INVALID_SHAPE" },
        { path: "actions", code: "NO_ACTIONS" },
      ]),
    );
    expect(h.refs.accounts.find).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it.each([
    [
      "account",
      { all: [{ field: "accountId", op: "eq", value: FOREIGN_ID }] },
      VALID_ACTIONS,
      "condition.all[0]",
    ],
    [
      "payee",
      VALID_CONDITION,
      [{ type: "set_payee", payeeId: FOREIGN_ID, onlyIfEmpty: true }],
      "actions[0]",
    ],
    [
      "category",
      { field: "categoryId", op: "in", value: [CATEGORY_ID, FOREIGN_ID] },
      VALID_ACTIONS,
      "condition",
    ],
    [
      "tag",
      VALID_CONDITION,
      [
        { type: "set_category", categoryId: CATEGORY_ID, onlyIfEmpty: true },
        { type: "remove_tags", tagIds: [TAG_ID, FOREIGN_ID] },
      ],
      "actions[1]",
    ],
  ])(
    "refuses a foreign or missing %s id at the leaf or action and writes nothing",
    async (_kind, condition, actions, path) => {
      const h = buildHarness();

      const error = await thrown(
        h.service.create(
          USER_ID,
          createDto({
            condition: condition as never,
            actions: actions as never,
          }),
        ),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          errorCode: "REFERENCE_NOT_FOUND",
          errors: [{ path, code: "REFERENCE_NOT_FOUND" }],
        }),
      );
      expect(h.writes()).toEqual([]);
    },
  );

  it("looks every referenced id up scoped to the caller", async () => {
    const h = buildHarness();

    await h.service.create(USER_ID, createDto());

    for (const repo of [
      h.refs.accounts,
      h.refs.payees,
      h.refs.categories,
      h.refs.tags,
    ]) {
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID }),
        }),
      );
    }
  });

  it("reports every missing reference, one entry per leaf or action", async () => {
    const h = buildHarness([]);

    const error = await thrown(h.service.create(USER_ID, createDto()));

    expect(error.getResponse().errors).toEqual([
      { path: "condition.all[0]", code: "REFERENCE_NOT_FOUND" },
      { path: "condition.all[1]", code: "REFERENCE_NOT_FOUND" },
      { path: "actions[0]", code: "REFERENCE_NOT_FOUND" },
      { path: "actions[1]", code: "REFERENCE_NOT_FOUND" },
    ]);
  });
});

describe("TransactionRulesService checkedCondition", () => {
  it("accepts a condition with no action beside it", async () => {
    const h = buildHarness();

    await expect(
      h.service.checkedCondition(h.manager as never, USER_ID, VALID_CONDITION),
    ).resolves.toEqual(VALID_CONDITION);
  });

  it("refuses a condition naming another user's id, at the leaf", async () => {
    const h = buildHarness();

    const error = await thrown(
      h.service.checkedCondition(h.manager as never, USER_ID, {
        all: [{ field: "accountId", op: "eq", value: FOREIGN_ID }],
      }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({
        errors: [{ path: "condition.all[0]", code: "REFERENCE_NOT_FOUND" }],
      }),
    );
  });

  it("refuses a malformed condition before looking anything up", async () => {
    const h = buildHarness();

    const error = await thrown(
      h.service.checkedCondition(h.manager as never, USER_ID, {
        field: "payeeText",
        op: "nope",
        value: "x",
      }),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(h.refs.accounts.find).not.toHaveBeenCalled();
  });
});
