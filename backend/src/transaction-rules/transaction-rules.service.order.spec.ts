import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  RULE_ID,
  USER_ID,
  buildHarness,
  storedRule,
  thrown,
} from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const R1 = "10000000-0000-4000-8000-000000000001";
const R2 = "10000000-0000-4000-8000-000000000002";
const R3 = "10000000-0000-4000-8000-000000000003";

const sqlOf = (call: unknown[]): string => String(call[0]);

describe("TransactionRulesService setEnabled", () => {
  it("is 404 for a missing rule", async () => {
    const h = buildHarness();

    await expect(
      h.service.setEnabled(USER_ID, RULE_ID, false),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.writes()).toEqual([]);
  });

  it("writes nothing when the value did not move", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ enabled: true }));

    const result = await h.service.setEnabled(USER_ID, RULE_ID, true);

    expect(h.writes()).toEqual([]);
    expect(result.revision).toBe(3);
  });

  it("toggles and bumps the revision, scoped to the caller", async () => {
    const h = buildHarness();
    h.rules.findOne
      .mockResolvedValueOnce(storedRule({ enabled: true }))
      .mockResolvedValueOnce(storedRule({ enabled: false, revision: 4 }));

    const result = await h.service.setEnabled(USER_ID, RULE_ID, false);

    expect(h.rules.update).toHaveBeenCalledWith(
      { id: RULE_ID, userId: USER_ID },
      { enabled: false, revision: expect.any(Function) },
    );
    expect(result).toEqual(
      expect.objectContaining({ enabled: false, revision: 4 }),
    );
  });
});

describe("TransactionRulesService remove", () => {
  it("is 404 for a missing rule and does not compact", async () => {
    const h = buildHarness();
    h.rules.delete.mockResolvedValue({ affected: 0 });

    await expect(h.service.remove(USER_ID, RULE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The lock, then the expiry of the rule's open review requests (A26-L16),
    // which the 404 rolls back with the transaction; no compaction.
    expect(h.manager.query).toHaveBeenCalledTimes(2);
    expect(sqlOf(h.manager.query.mock.calls[0])).toContain(
      "pg_advisory_xact_lock",
    );
    expect(sqlOf(h.manager.query.mock.calls[1])).toContain(
      "UPDATE ai_review_requests",
    );
  });

  it("deletes under the lock, then closes the gap in the same transaction", async () => {
    const h = buildHarness();

    await h.service.remove(USER_ID, RULE_ID);

    expect(h.rules.delete).toHaveBeenCalledWith({
      id: RULE_ID,
      userId: USER_ID,
    });
    const [lock, expire, compact] = h.manager.query.mock.calls;
    expect(sqlOf(lock)).toContain("pg_advisory_xact_lock");
    // A26-L16: the rule's open review requests are expired BEFORE the delete,
    // while `rule_id` still names the rule (ON DELETE SET NULL clears it).
    expect(sqlOf(expire)).toContain("UPDATE ai_review_requests");
    expect(sqlOf(expire)).toContain("status = 'expired'");
    expect(expire[1]).toEqual([USER_ID, RULE_ID]);
    expect(h.manager.query.mock.invocationCallOrder[1]).toBeLessThan(
      h.rules.delete.mock.invocationCallOrder[0],
    );
    expect(sqlOf(compact)).toContain("UPDATE transaction_rules");
    expect(sqlOf(compact)).toContain("ROW_NUMBER() OVER (ORDER BY position)");
    expect(compact[1]).toEqual([USER_ID]);
    expect(h.rules.delete.mock.invocationCallOrder[0]).toBeLessThan(
      h.manager.query.mock.invocationCallOrder[2],
    );
  });
});

describe("TransactionRulesService remove with an expected revision", () => {
  it("refuses a rule edited since the card showed it, before deleting anything", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ revision: 4 }));

    const error = await thrown(h.service.remove(USER_ID, RULE_ID, 3));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      errorCode: "REVISION_CONFLICT",
    });
    expect(h.writes()).toEqual([]);
  });

  it("deletes a rule still at the revision the card showed", async () => {
    const h = buildHarness();
    h.rules.findOne.mockResolvedValue(storedRule({ revision: 3 }));

    await h.service.remove(USER_ID, RULE_ID, 3);

    expect(h.rules.findOne).toHaveBeenCalledWith({
      where: { id: RULE_ID, userId: USER_ID },
    });
    expect(h.rules.delete).toHaveBeenCalledWith({
      id: RULE_ID,
      userId: USER_ID,
    });
  });

  it("is 404 for a rule that is gone, without deleting", async () => {
    const h = buildHarness();

    await expect(h.service.remove(USER_ID, RULE_ID, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.writes()).toEqual([]);
  });

  it("keeps deleting without a check when the caller states no expectation", async () => {
    const h = buildHarness();

    await h.service.remove(USER_ID, RULE_ID);

    expect(h.rules.findOne).not.toHaveBeenCalled();
    expect(h.rules.delete).toHaveBeenCalled();
  });
});

describe("TransactionRulesService reorder", () => {
  const owned = [{ id: R1 }, { id: R2 }, { id: R3 }];

  it.each([
    ["a partial list", [R1, R2]],
    ["an unknown id", [R1, R2, "10000000-0000-4000-8000-0000000000ff"]],
    ["a repeated id", [R1, R1, R2]],
    ["an extra id", [R1, R2, R3, "10000000-0000-4000-8000-0000000000ff"]],
  ])("refuses %s and rewrites nothing", async (_name, ids) => {
    const h = buildHarness();
    h.rules.find.mockResolvedValue(owned);

    let error: any;
    try {
      await h.service.reorder(USER_ID, ids);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ errorCode: "RULE_LIST_CHANGED" }),
    );
    expect(h.writes()).toEqual([]);
  });

  it("rewrites all positions in one statement under the lock, then returns the new order", async () => {
    const h = buildHarness();
    h.rules.find
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce([
        storedRule({ id: R3, position: 0 }),
        storedRule({ id: R1, position: 1 }),
        storedRule({ id: R2, position: 2 }),
      ]);

    const result = await h.service.reorder(USER_ID, [R3, R1, R2]);

    expect(h.manager.query).toHaveBeenCalledTimes(2);
    const [lock, rewrite] = h.manager.query.mock.calls;
    expect(sqlOf(lock)).toContain("pg_advisory_xact_lock");
    expect(sqlOf(rewrite)).toContain("unnest($2::uuid[]) WITH ORDINALITY");
    expect(rewrite[1]).toEqual([USER_ID, [R3, R1, R2]]);
    expect(result.map((r) => [r.id, r.position])).toEqual([
      [R3, 0],
      [R1, 1],
      [R2, 2],
    ]);
  });

  it("accepts an empty list for a user with no rules", async () => {
    const h = buildHarness();

    await expect(h.service.reorder(USER_ID, [])).resolves.toEqual([]);
  });
});
