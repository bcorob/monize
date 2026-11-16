import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../../../test-helpers/scoped-db-testing";
import { GOOGLE_PLACES_QUOTA_TIMEZONE } from "./google-places-cap";
import {
  PayeeLookupQuotaService,
  QuotaScope,
} from "./payee-lookup-quota.service";

jest.mock("../../../common/db/scoped-db", () => {
  const actual = jest.requireActual(
    "../../../test-helpers/scoped-db-testing",
  ) as { scopedDbMockModule: () => Record<string, unknown> };
  return {
    ...actual.scopedDbMockModule(),
    // The claim must commit whatever transaction discovered it does, so it
    // deliberately steps outside an ambient manager. The helper module does not
    // model that, and the spec asserts the SQL rather than the nesting.
    runOutsideActiveScopedManager: <T>(fn: () => T): T => fn(),
  };
});

jest.mock("../../../common/db/with-context", () => ({
  withSystemContext: jest.fn(<T>(fn: () => T): T => fn()),
}));

const { withSystemContext } = jest.requireMock(
  "../../../common/db/with-context",
) as { withSystemContext: jest.Mock };

const userScope: QuotaScope = {
  kind: "user",
  userId: "user-1",
  capEnabled: true,
  cap: 1000,
};
const operatorScope: QuotaScope = {
  kind: "operator",
  capEnabled: true,
  cap: 1000,
};

describe("PayeeLookupQuotaService", () => {
  let service: PayeeLookupQuotaService;
  let manager: Record<string, jest.Mock>;

  const lastCall = (): unknown[] => {
    const calls = manager.query.mock.calls;
    return (calls[calls.length - 1] ?? []) as unknown[];
  };
  const lastSql = (): string => lastCall()[0] as string;
  const lastParams = (): unknown[] => lastCall()[1] as unknown[];
  const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();
  /** Run a claim purely to capture the statement it issued. */
  const claimSql = async (scope: QuotaScope): Promise<string> => {
    await service.claim(scope);
    return lastSql();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const scoped = createScopedDbMocks();
    manager = scoped.manager;
    manager.query.mockResolvedValue([{ used: 1 }]);
    service = new PayeeLookupQuotaService(
      scoped.dataSource as unknown as DataSource,
    );
  });

  describe("claiming one request", () => {
    it("increments the caller's own counter and returns the new count", async () => {
      manager.query.mockResolvedValue([{ used: 7 }]);

      await expect(service.claim(userScope)).resolves.toBe(7);
      expect(squash(lastSql())).toContain(
        "INSERT INTO payee_lookup_usage (user_id, month, google_places_requests)",
      );
      expect(lastParams()).toEqual([
        "user-1",
        true,
        1000,
        GOOGLE_PLACES_QUOTA_TIMEZONE,
      ]);
    });

    it("refuses to increment past the cap, in the statement itself", async () => {
      // A read-then-write would let two callers past a cap of one; the
      // condition has to be part of the write for the database to decide.
      expect(squash(await claimSql(userScope))).toContain(
        "WHERE $2::boolean = false OR payee_lookup_usage.google_places_requests < $3",
      );
    });

    it("reads no rows back as the cap being reached", async () => {
      manager.query.mockResolvedValue([]);

      await expect(service.claim(userScope)).resolves.toBeNull();
    });

    it("lets an uncapped scope through by parameter, not by a second statement", async () => {
      await service.claim({ ...userScope, capEnabled: false });

      expect(lastParams()).toEqual([
        "user-1",
        false,
        1000,
        GOOGLE_PLACES_QUOTA_TIMEZONE,
      ]);
    });

    it("takes the month from the database, never from this process's clock", async () => {
      // Every replica has to roll over on one clock, and a caller must not be
      // able to disagree with the row it is incrementing.
      await service.claim(userScope);

      expect(lastSql()).toContain("to_char(now() AT TIME ZONE $4, 'YYYY-MM')");
    });
  });

  describe("the operator's counter", () => {
    it("counts against the deployment-wide table under system context", async () => {
      // The row has no owner: one operator key is one bill, whoever spent it.
      manager.query.mockResolvedValue([{ used: 3 }]);

      await expect(service.claim(operatorScope)).resolves.toBe(3);
      expect(squash(lastSql())).toContain(
        "INSERT INTO google_places_instance_usage (month, requests)",
      );
      expect(lastParams()).toEqual([true, 1000, GOOGLE_PLACES_QUOTA_TIMEZONE]);
      expect(withSystemContext).toHaveBeenCalled();
    });

    it("returns its own count, not an empty result", async () => {
      // The instance statement needs its own RETURNING; without one every claim
      // would read as "cap reached" and every lookup would fall back to AI.
      expect(squash(await claimSql(operatorScope))).toContain(
        "RETURNING requests AS used",
      );
    });

    it("reads a refused instance claim as the cap being reached", async () => {
      manager.query.mockResolvedValue([]);

      await expect(service.claim(operatorScope)).resolves.toBeNull();
    });
  });

  describe("reading this month's usage", () => {
    it("reads the user's row", async () => {
      manager.query.mockResolvedValue([{ used: 42 }]);

      await expect(service.usedThisMonth(userScope)).resolves.toBe(42);
      expect(lastSql()).toContain("FROM payee_lookup_usage");
    });

    it("reads the deployment's row for the operator's key", async () => {
      manager.query.mockResolvedValue([{ used: 9 }]);

      await expect(service.usedThisMonth(operatorScope)).resolves.toBe(9);
      expect(lastSql()).toContain("FROM google_places_instance_usage");
    });

    it("reads a month with no row yet as nothing spent", async () => {
      manager.query.mockResolvedValue([]);

      await expect(service.usedThisMonth(userScope)).resolves.toBe(0);
    });

    it("coerces the driver's string count to a number", async () => {
      // pg returns an integer aggregate as a string often enough that a bare
      // pass-through would compare "1000" against 1000 and never reach a cap.
      manager.query.mockResolvedValue([{ used: "17" }]);

      await expect(service.usedThisMonth(userScope)).resolves.toBe(17);
    });
  });
});
