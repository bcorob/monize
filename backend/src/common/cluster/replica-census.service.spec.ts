import { getRequestContext, RequestContext } from "../request-context";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import {
  APPLICATION_NAME,
  APPLICATION_NAME_PREFIX,
  INSTANCE_ID,
  PROCESS_STARTED_AT_EPOCH_S,
} from "./instance-id";
import {
  REPLICA_CENSUS_MAX_AGE_MS,
  REPLICA_CENSUS_MIN_AGE_MINUTES,
  ReplicaCensusService,
} from "./replica-census.service";

/**
 * Runs against the REAL `withScopedDb` at `RLS_MODE=enforce` (the pattern of
 * the `rls-context-smoke.spec.ts` files), so the identity the census reads
 * under is observed rather than assumed: its callers are a cron and the health
 * endpoint, and neither carries a user.
 *
 * What a mock cannot show -- that `pg_stat_activity` really exposes another
 * session's `application_name`, and that the pattern reads the start time back
 * -- was checked by hand against PostgreSQL 16; the SQL is asserted here so a
 * change to it is a deliberate edit.
 */
describe("ReplicaCensusService", () => {
  const BYPASS_SQL = "SELECT set_config('app.bypass_rls', 'on', true)";
  const originalMode = process.env.RLS_MODE;

  let manager: Record<string, jest.Mock>;
  let service: ReplicaCensusService;
  let censusContext: RequestContext | undefined;
  let answer: unknown;

  beforeEach(() => {
    process.env.RLS_MODE = "enforce";
    censusContext = undefined;
    answer = [{ n: 1 }];
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    manager.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("pg_stat_activity")) {
        censusContext = getRequestContext();
        return answer;
      }
      return [];
    });
    service = new ReplicaCensusService(mocks.dataSource as never);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = originalMode;
  });

  const censusCall = (): [string, unknown[]] =>
    manager.query.mock.calls.find(([sql]: [string]) =>
      sql.includes("pg_stat_activity"),
    ) as [string, unknown[]];

  it("counts distinct backend sessions, by prefix, older than the process age", async () => {
    await service.countActiveProcesses();

    const [sql, params] = censusCall();
    expect(sql).toMatch(/count\(DISTINCT application_name\)::int AS n/);
    expect(sql).toMatch(/FROM pg_stat_activity/);
    // The view spans the server: another Monize database on it (staging beside
    // production) is another deployment, not a second replica of this one.
    expect(sql).toMatch(/WHERE datname = current_database\(\)/);
    // A prefix test with no pattern characters: the prefix is compared as-is.
    expect(sql).toMatch(/starts_with\(application_name, \$1\)/);
    expect(sql).not.toMatch(/LIKE/);
    // The age is the process's, read out of the name -- never backend_start,
    // which an idle pool keeps young and PostgreSQL masks on other roles' rows.
    expect(sql).toMatch(/substring\(application_name FROM \$2\)::bigint/);
    expect(sql).not.toMatch(/backend_start/);
    expect(params).toEqual([
      "monize-backend:",
      "@([0-9]{1,12})$",
      REPLICA_CENSUS_MIN_AGE_MINUTES,
    ]);
    expect(REPLICA_CENSUS_MIN_AGE_MINUTES).toBe(10);
  });

  it("the start-time pattern reads this process's own name back", async () => {
    await service.countActiveProcesses();
    const [, params] = censusCall();
    const match = new RegExp(params[1] as string).exec(APPLICATION_NAME);
    expect(Number(match?.[1])).toBe(PROCESS_STARTED_AT_EPOCH_S);
    // And the prefix test matches it.
    expect(params[0]).toBe(APPLICATION_NAME_PREFIX);
    expect(APPLICATION_NAME.startsWith(params[0] as string)).toBe(true);
  });

  it("reads under a system context it seeds itself, with no ambient identity", async () => {
    await service.countActiveProcesses();

    expect(censusContext?.system).toBe(true);
    expect(
      manager.query.mock.calls
        .map(([sql]: [string]) => sql)
        .filter((sql: string) => sql.includes("set_config")),
    ).toEqual([BYPASS_SQL]);
  });

  it.each([
    [[{ n: 3 }], 3],
    [[{ n: "2" }], 2],
    [[{ n: 0 }], 0],
    [[], 0],
  ])("reads n from %j as %d", async (rows, expected) => {
    answer = rows;
    await expect(service.countActiveProcesses()).resolves.toBe(expected);
  });

  describe("the cached count GET /health reads", () => {
    it("is null before any census, then the last count taken", async () => {
      expect(service.lastKnownCount()).toBeNull();
      answer = [{ n: 2 }];
      await service.countActiveProcesses();
      expect(service.lastKnownCount()).toBe(2);
    });

    it("stops reporting a count older than two sweeps", async () => {
      // Bracket the census's own timestamp: it was taken no earlier than
      // `before` and no later than `after`, so these two probes sit on either
      // side of the limit however many milliseconds the census took.
      const before = Date.now();
      await service.countActiveProcesses();
      const after = Date.now();
      expect(service.lastKnownCount(before + REPLICA_CENSUS_MAX_AGE_MS)).toBe(
        1,
      );
      expect(
        service.lastKnownCount(after + REPLICA_CENSUS_MAX_AGE_MS + 1),
      ).toBeNull();
    });

    it("never queries", () => {
      manager.query.mockClear();
      service.lastKnownCount();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("keeps the previous count when a census fails", async () => {
      answer = [{ n: 2 }];
      await service.countActiveProcesses();
      manager.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes("pg_stat_activity")) {
          throw new Error("connection terminated");
        }
        return [];
      });
      await expect(service.countActiveProcesses()).rejects.toThrow();
      // Until it ages out: a failed read is not evidence the peer left.
      expect(service.lastKnownCount()).toBe(2);
    });
  });

  it("propagates a database failure to the caller, which decides what it means", async () => {
    manager.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("pg_stat_activity")) {
        throw new Error("connection terminated");
      }
      return [];
    });
    await expect(service.countActiveProcesses()).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("instance identity", () => {
  it("is one UUID per process, carried in a name PostgreSQL will not truncate", () => {
    expect(INSTANCE_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(APPLICATION_NAME).toBe(
      `monize-backend:${INSTANCE_ID}@${PROCESS_STARTED_AT_EPOCH_S}`,
    );
    // NAMEDATALEN - 1: a longer name is silently cut, which would drop the
    // start time the census reads back.
    expect(Buffer.byteLength(APPLICATION_NAME, "utf8")).toBeLessThanOrEqual(63);
  });

  it("records the start in whole seconds, not in the future", () => {
    expect(Number.isInteger(PROCESS_STARTED_AT_EPOCH_S)).toBe(true);
    expect(PROCESS_STARTED_AT_EPOCH_S).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000),
    );
  });
});
