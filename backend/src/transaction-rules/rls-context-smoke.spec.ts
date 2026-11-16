import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRule } from "./transaction-rule.entity";
import { withUserContext } from "../common/db/with-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the transaction-rules module (real `withScopedDb`, which is
 * deliberately not mocked here). Every method is reached through the request
 * interceptor's ambient context in production, so with none seeded the real
 * implementation must refuse each of them; with one seeded it must run the
 * callback on the transaction's manager.
 */
describe("transaction-rules module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";
  const RULE_ID = "9d0a3c4e-1b6f-4d2a-8e57-2c1f0b7a6d11";

  const build = () => {
    const rules = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    const { dataSource } = createScopedDbMocks([[TransactionRule, rules]]);
    return {
      rules,
      dataSource,
      service: new TransactionRulesService(dataSource as never),
    };
  };

  it.each([
    ["list", (s: TransactionRulesService) => s.list("u1")],
    ["get", (s: TransactionRulesService) => s.get("u1", RULE_ID)],
    [
      "setEnabled",
      (s: TransactionRulesService) => s.setEnabled("u1", RULE_ID, true),
    ],
    ["remove", (s: TransactionRulesService) => s.remove("u1", RULE_ID)],
    ["reorder", (s: TransactionRulesService) => s.reorder("u1", [])],
  ])("refuses %s without an ambient context", async (_name, call) => {
    const { service, dataSource } = build();

    await expect(call(service)).rejects.toThrow(
      "DB access outside request/user/system context",
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it("runs a read on the transaction's manager inside a user context", async () => {
    const { service, rules, dataSource } = build();

    await withUserContext(OWNER_ID, () => service.list(OWNER_ID));

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(rules.find).toHaveBeenCalledWith({
      where: { userId: OWNER_ID },
      order: { position: "ASC" },
    });
  });
});
