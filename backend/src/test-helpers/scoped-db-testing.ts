import { EntityManager, EntityTarget } from "typeorm";

/**
 * Unit-test harness for services refactored onto `withScopedDb` (RLS tasks R1-R7).
 *
 * Real `withScopedDb` refuses to run without an ambient request/user/system
 * context and opens a real transaction; unit tests need neither. Specs mock
 * the module so `withScopedDb(ds, fn)` simply delegates to the (mock)
 * `dataSource.transaction(fn)`:
 *
 *   jest.mock("../common/db/scoped-db", () =>
 *     jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
 *   );
 *
 * and build the manager/dataSource pair with `createScopedDbMocks`, routing
 * `manager.getRepository(Entity)` to the same per-entity mock repositories the
 * specs already assert against. The context-throw and GUC-emission behavior of
 * the real withScopedDb stays covered by its own spec (scoped-db.spec.ts).
 */

/** Mock EntityManager: every method a jest.fn, plus entity-routed getRepository. */
export type ManagerMock = Record<string, jest.Mock>;

/** Mock DataSource whose transaction() runs the callback with the ManagerMock. */
export interface DataSourceMock {
  transaction: jest.Mock;
  query: jest.Mock;
  manager: ManagerMock;
}

/**
 * Module factory for `jest.mock` of `src/common/db/scoped-db`. The replacement
 * `withScopedDb` skips the ambient-context check and runs the callback through the
 * caller-provided (mock) `dataSource.transaction`, so specs can both drive the
 * callback (via `createScopedDbMocks`) and assert transactional grouping (via
 * `dataSource.transaction.mock.calls`).
 *
 * An explicit isolation level is forwarded in TypeORM's own argument order
 * (`transaction(isolation, fn)`), so a spec can still assert that a caller asked
 * for SERIALIZABLE -- registration's first-user-admin race depends on it, and
 * swallowing the argument here would make that assertion unwritable.
 */
export function scopedDbMockModule() {
  return {
    withScopedDb: jest.fn(
      (
        dataSource: {
          transaction: (
            ...args:
              | [(m: unknown) => unknown]
              | [string, (m: unknown) => unknown]
          ) => unknown;
        },
        fn: (m: unknown) => unknown,
        isolation?: string,
      ) =>
        isolation
          ? dataSource.transaction(isolation, fn)
          : dataSource.transaction(fn),
    ),
    /**
     * Calls straight through and **returns the callback's value**, like the real
     * one does.
     *
     * Worth spelling out: a double that swallowed the return value would make
     * every `await runOutsideActiveScopedManager(...)` resolve to `undefined`, so
     * a caller reading the result -- a conditional claim's row count, a promise it
     * attaches a `.catch` to -- would fail with a `TypeError` about `undefined`
     * rather than anything resembling its cause. Whether the callback really got
     * its own connection is not a question a mock can answer; `scoped-db.spec.ts`
     * covers that.
     */
    runOutsideActiveScopedManager: jest.fn((fn: () => unknown) => fn()),
  };
}

/**
 * Build the mock manager + dataSource pair for a spec.
 *
 * @param repos entity-class -> mock-repository entries backing
 *   `manager.getRepository`. Entities the service never asks for may be
 *   omitted; asking for an unregistered entity throws with a clear message so
 *   the spec failure names the missing mock instead of dying on `undefined`.
 */
export function createScopedDbMocks(
  repos: Array<[EntityTarget<unknown>, Record<string, jest.Mock>]> = [],
): { manager: ManagerMock; dataSource: DataSourceMock } {
  const repoMap = new Map<EntityTarget<unknown>, Record<string, jest.Mock>>(
    repos,
  );

  const manager: ManagerMock = {
    getRepository: jest.fn((entity: EntityTarget<unknown>) => {
      const repo = repoMap.get(entity);
      if (!repo) {
        const name =
          typeof entity === "function" ? entity.name : String(entity);
        throw new Error(
          `createScopedDbMocks: no mock repository registered for entity "${name}"`,
        );
      }
      return repo;
    }),
    // Direct EntityManager methods, for code converted from queryRunner.manager.
    find: jest.fn(),
    findBy: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    merge: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const dataSource: DataSourceMock = {
    // Both TypeORM signatures: `transaction(fn)` and
    // `transaction(isolationLevel, fn)`. Handling only the first made every
    // caller that asks for an isolation level fail with "fn is not a function" --
    // a double that cannot do what the real collaborator does, which is how the
    // backup export's REPEATABLE READ snapshot surfaced as nine broken specs
    // rather than as a passing change.
    transaction: jest.fn(
      async (
        first: string | ((m: EntityManager) => unknown),
        second?: (m: EntityManager) => unknown,
      ) => {
        const fn = typeof first === "function" ? first : second!;
        return fn(manager as unknown as EntityManager) as Promise<unknown>;
      },
    ),
    query: jest.fn(),
    manager,
  };

  return { manager, dataSource };
}

/**
 * Teach a manager.query mock to answer the `oidc_step_up_claims` statements
 * `OidcReauthService.consume` issues, delegating everything else to whatever
 * implementation the spec already installed.
 *
 * The ledger is what makes a re-auth artifact single-use across replicas, so a
 * spec that exercises the real `OidcReauthService` (deliberately -- a mock that
 * always accepts would make the re-authentication assertions vacuous) needs the
 * INSERT to answer like the table: one row for the caller that created the
 * claim, none for a replay.
 */
export function withStepUpClaimLedger(query: jest.Mock): {
  rows: Set<string>;
} {
  const rows = new Set<string>();
  const previous = query.getMockImplementation();
  query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes("oidc_step_up_claims")) {
      if (text.trimStart().startsWith("DELETE")) return [];
      const jti = String((params as unknown[] | undefined)?.[0]);
      if (rows.has(jti)) return [];
      rows.add(jti);
      return [{ jti }];
    }
    return previous ? previous(sql, params) : [];
  });
  return { rows };
}
