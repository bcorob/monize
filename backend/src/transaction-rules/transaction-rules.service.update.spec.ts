import { ConflictException, NotFoundException } from "@nestjs/common";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import {
  ACCOUNT_ID,
  CATEGORY_ID,
  FOREIGN_ID,
  PAYEE_ID,
  RULE_ID,
  TAG_ID,
  USER_ID,
  VALID_ACTIONS,
  VALID_CONDITION,
  buildHarness,
  storedRule,
  thrown,
} from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("TransactionRulesService update", () => {
  const dto = (over: Partial<UpdateTransactionRuleDto> = {}) =>
    ({ revision: 3, ...over }) as UpdateTransactionRuleDto;

  it("refuses a stale revision with 409 and writes nothing", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ revision: 4 }));

    const error = await thrown(
      h.service.update(USER_ID, RULE_ID, dto({ name: "Renamed" })),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ errorCode: "REVISION_CONFLICT" }),
    );
    expect(h.writes()).toEqual([]);
  });

  it("is 404 for a missing or foreign rule", async () => {
    const h = buildHarness();

    await expect(
      h.service.update(USER_ID, RULE_ID, dto({ name: "x" })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.rules.findOne).toHaveBeenCalledWith({
      where: { id: RULE_ID, userId: USER_ID },
    });
    expect(h.writes()).toEqual([]);
  });

  it("swaps on the revision it read and bumps it", async () => {
    const h = buildHarness();
    h.rules.findOne
      .mockResolvedValueOnce(storedRule())
      .mockResolvedValueOnce(storedRule({ name: "Renamed", revision: 4 }));

    const result = await h.service.update(
      USER_ID,
      RULE_ID,
      dto({ name: "Renamed" }),
    );

    expect(h.rules.update).toHaveBeenCalledWith(
      { id: RULE_ID, userId: USER_ID, revision: 3 },
      { name: "Renamed", revision: expect.any(Function) },
    );
    const patch = h.rules.update.mock.calls[0][1];
    expect(patch.revision()).toBe("revision + 1");
    expect(result).toEqual(
      expect.objectContaining({ name: "Renamed", revision: 4 }),
    );
  });

  it("treats a resent unchanged form as no edit: no write, same revision", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule());

    const result = await h.service.update(
      USER_ID,
      RULE_ID,
      dto({
        name: "Groceries",
        enabled: true,
        triggers: ["create", "import"],
        condition: JSON.parse(JSON.stringify(VALID_CONDITION)),
        actions: JSON.parse(JSON.stringify(VALID_ACTIONS)),
        stopProcessing: false,
      }),
    );

    expect(h.writes()).toEqual([]);
    expect(result.revision).toBe(3);
  });

  it("loses the swap when the row moved after the read", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule());
    h.rules.update.mockResolvedValue({ affected: 0 });

    await expect(
      h.service.update(USER_ID, RULE_ID, dto({ name: "Renamed" })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("validates a new condition together with the stored actions", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ actions: [] }));

    const error = await thrown(
      h.service.update(
        USER_ID,
        RULE_ID,
        dto({
          condition: { field: "hasSplits", op: "eq", value: true } as never,
        }),
      ),
    );

    expect(error.getResponse().errors).toEqual([
      { path: "actions", code: "NO_ACTIONS" },
    ]);
    expect(h.writes()).toEqual([]);
  });

  it("refuses a foreign id in an updated action and writes nothing", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule());

    const error = await thrown(
      h.service.update(
        USER_ID,
        RULE_ID,
        dto({ actions: [{ type: "add_tags", tagIds: [FOREIGN_ID] }] as never }),
      ),
    );

    expect(error.getResponse().errors).toEqual([
      { path: "actions[0]", code: "REFERENCE_NOT_FOUND" },
    ]);
    expect(h.writes()).toEqual([]);
  });

  it("stores the onlyIfEmpty default on an updated action", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule());

    await h.service.update(
      USER_ID,
      RULE_ID,
      dto({ actions: [{ type: "set_payee", payeeId: PAYEE_ID }] as never }),
    );

    expect(h.rules.update.mock.calls[0][1].actions).toEqual([
      { type: "set_payee", payeeId: PAYEE_ID, onlyIfEmpty: true },
    ]);
  });
});

describe("TransactionRulesService reads", () => {
  it("lists in position order without touching the lock", async () => {
    const h = buildHarness();
    h.rules.find.mockResolvedValue([
      storedRule({ id: "r1", position: 0 }),
      storedRule({ id: "r2", position: 1 }),
    ]);

    const result = await h.service.list(USER_ID);

    expect(h.rules.find).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { position: "ASC" },
    });
    expect(result.map((r) => [r.id, r.invalid])).toEqual([
      ["r1", false],
      ["r2", false],
    ]);
    expect(h.manager.query).not.toHaveBeenCalled();
  });

  it("lists a stored rule with a regex-looking or bare-word pattern as not invalid", async () => {
    const h = buildHarness();
    h.rules.find.mockResolvedValue([
      storedRule({
        condition: {
          all: [{ field: "description", op: "matches", value: "NETFLIX.COM" }],
        } as never,
      }),
    ]);

    const [rule] = await h.service.list(USER_ID);

    expect(rule.invalid).toBe(false);
    expect(rule.invalidReasons).toEqual([]);
  });

  it("marks a restored rule with an empty definition invalid and does not throw", async () => {
    const h = buildHarness();
    h.rules.find.mockResolvedValue([
      storedRule({ condition: {} as never, actions: [] }),
    ]);

    const [rule] = await h.service.list(USER_ID);

    expect(rule.invalid).toBe(true);
    expect(rule.invalidReasons).toEqual(
      expect.arrayContaining([
        { path: "condition", code: "INVALID_SHAPE" },
        { path: "actions", code: "NO_ACTIONS" },
      ]),
    );
  });

  it("marks a rule whose referenced id was deleted invalid, at the action", async () => {
    const h = buildHarness([ACCOUNT_ID, PAYEE_ID, TAG_ID]);
    h.rules.find.mockResolvedValue([storedRule()]);

    const [rule] = await h.service.list(USER_ID);

    expect(rule.invalid).toBe(true);
    expect(rule.invalidReasons).toEqual([
      { path: "actions[0]", code: "REFERENCE_NOT_FOUND" },
    ]);
  });

  it("does not blame a valid rule for another rule's missing id", async () => {
    const h = buildHarness([ACCOUNT_ID, PAYEE_ID, CATEGORY_ID, TAG_ID]);
    h.rules.find.mockResolvedValue([
      storedRule({ id: "r1" }),
      storedRule({
        id: "r2",
        actions: [{ type: "add_tags", tagIds: [FOREIGN_ID] }],
      }),
    ]);

    const result = await h.service.list(USER_ID);

    expect(result.map((r) => r.invalid)).toEqual([false, true]);
  });

  it("looks the references of all rules up once per kind", async () => {
    const h = buildHarness();
    h.rules.find.mockResolvedValue([
      storedRule({ id: "r1" }),
      storedRule({ id: "r2" }),
    ]);

    await h.service.list(USER_ID);

    expect(h.refs.accounts.find).toHaveBeenCalledTimes(1);
    expect(h.refs.tags.find).toHaveBeenCalledTimes(1);
  });

  it("gets one rule, or 404", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValueOnce(storedRule());

    await expect(h.service.get(USER_ID, RULE_ID)).resolves.toEqual(
      expect.objectContaining({ id: RULE_ID, invalid: false }),
    );
    await expect(h.service.get(USER_ID, RULE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
