import { DataSource, EntityManager } from "typeorm";
import { runWithActiveScopedManager } from "../../../common/db/scoped-db";
import { withUserContext } from "../../../common/db/with-context";
import {
  PayeeLookupQuotaService,
  QuotaScope,
} from "./payee-lookup-quota.service";

/**
 * INV-PAYEE-002, the half the sibling spec cannot see: **the claim commits
 * before the request goes out, even when the caller is inside a transaction.**
 *
 * `payee-lookup-quota.service.spec.ts` mocks `withScopedDb` and replaces
 * `runOutsideActiveScopedManager` with a passthrough, because its subject is
 * the SQL. That makes the nesting invisible there by construction: deleting
 * `runOutsideActiveScopedManager` from the service leaves every one of its
 * assertions green, and the integration spec never calls `claim` from inside
 * an ambient `withScopedDb` either. So the mechanism the invariant names as
 * its enforcement was the one thing nothing exercised.
 *
 * This spec therefore uses the REAL `withScopedDb` against a fake `DataSource`
 * -- the point is which manager the statement lands on, and that is a property
 * of the ALS plumbing rather than of PostgreSQL.
 *
 * Why it matters: Google bills an attempt whatever comes back. A claim that
 * joined its caller's transaction would be rolled back by whatever operation
 * discovered the cap -- handing back a slot that has already been paid for,
 * and under-counting is the direction that spends money.
 */
describe("PayeeLookupQuotaService transaction independence (INV-PAYEE-002)", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const userScope: QuotaScope = {
    kind: "user",
    userId: USER_ID,
    capEnabled: true,
    cap: 1000,
  };
  const operatorScope: QuotaScope = {
    kind: "operator",
    capEnabled: true,
    cap: 1000,
  };

  let service: PayeeLookupQuotaService;
  /** The manager a caller already holds open. Nothing here may touch it. */
  let outerManager: EntityManager;
  /** The manager the claim's own transaction runs on. */
  let innerManager: { query: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    innerManager = { query: jest.fn().mockResolvedValue([{ used: 1 }]) };
    outerManager = {
      query: jest.fn().mockResolvedValue([{ used: 999 }]),
    } as unknown as EntityManager;
    dataSource = {
      transaction: jest.fn((fn: (m: unknown) => unknown) => fn(innerManager)),
    };
    service = new PayeeLookupQuotaService(dataSource as unknown as DataSource);
  });

  /** Run `fn` as a caller that is already inside a scoped transaction. */
  const insideAmbientTransaction = <T>(fn: () => T): T =>
    withUserContext(USER_ID, () =>
      runWithActiveScopedManager(outerManager, fn),
    );

  it("opens its own transaction rather than joining the caller's", async () => {
    await expect(
      insideAmbientTransaction(() => service.claim(userScope)),
    ).resolves.toBe(1);

    // A second transaction, on its own connection: it commits when it returns,
    // not when the caller does.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(innerManager.query).toHaveBeenCalledTimes(1);
    // The caller's manager is untouched. Were the claim to join it, the
    // statement would land here and share the caller's fate.
    expect(outerManager.query).not.toHaveBeenCalled();
  });

  it("claims the operator's counter on its own transaction too", async () => {
    // This one would not merely be rolled back if it joined: the instance
    // counter is claimed under withSystemContext, and joining a user-identity
    // transaction with a system identity is refused outright by withScopedDb.
    // Either way the claim is lost, so the assertion is the same.
    await expect(
      insideAmbientTransaction(() => service.claim(operatorScope)),
    ).resolves.toBe(1);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(outerManager.query).not.toHaveBeenCalled();
  });

  it("still claims when there is no ambient transaction at all", async () => {
    // The ordinary path -- every current caller runs the lookup outside a
    // transaction. Stepping outside an ALS scope that is not there is a no-op,
    // and this pins that it stays one.
    await expect(
      withUserContext(USER_ID, () => service.claim(userScope)),
    ).resolves.toBe(1);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it("reads usage without disturbing the caller's transaction", async () => {
    innerManager.query.mockResolvedValue([{ used: 42 }]);

    await expect(
      insideAmbientTransaction(() => service.usedThisMonth(operatorScope)),
    ).resolves.toBe(42);

    // The operator's counter is read under system context. Joining a
    // user-identity transaction would throw the identity-mismatch error rather
    // than return a number, so this asserts the read is as independent as the
    // claim beside it.
    expect(outerManager.query).not.toHaveBeenCalled();
  });
});
