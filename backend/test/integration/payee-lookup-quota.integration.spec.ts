import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { PayeeLookupQuotaService } from "@/payees/lookup/google-places/payee-lookup-quota.service";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { GOOGLE_PLACES_QUOTA_TIMEZONE } from "@/payees/lookup/google-places/google-places-cap";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * INV-PAYEE-002 -- the two-connection proof.
 *
 * The claim is that the number of Google Places requests made in one BILLING
 * month -- Pacific, the zone Google's free allowance resets in -- never exceeds
 * the cap for the key's owner. A unit spec can only assert
 * the SQL string; whether the statement actually refuses a concurrent second
 * claimant is a property of PostgreSQL, and only a real database can answer it.
 *
 * The interleaving needs no barrier here, and that is worth stating rather than
 * assuming. The mechanism is a single `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE`, so each claimant's read and write are one statement: the second one
 * blocks on the first's row lock inside the statement and re-evaluates the
 * `WHERE` against the committed value. There is no window between a read and a
 * write for a barrier to hold open -- which is precisely the property being
 * tested, and why a read-then-write implementation would fail this spec even
 * under a plain `Promise.all`.
 */
describe("Google Places quota claim (INV-PAYEE-002)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let quota: PayeeLookupQuotaService;
  let userId: string;

  beforeAll(async () => {
    // The service's only collaborator is the DataSource, and the subject here
    // is the statement it sends -- AccountsModule is imported solely because
    // the shared harness resolves NetWorthService out of the built module.
    module = await createIntegrationModule([AccountsModule]);
    dataSource = module.get(DataSource);
    quota = new PayeeLookupQuotaService(dataSource);
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "payee_lookup_usage",
      "google_places_instance_usage",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
  });

  const userScope = (cap: number, capEnabled = true) =>
    ({ kind: "user", userId, capEnabled, cap }) as const;
  const operatorScope = (cap: number, capEnabled = true) =>
    ({ kind: "operator", capEnabled, cap }) as const;

  const storedCount = async (): Promise<number> => {
    const rows = await withSystemContext(() =>
      dataSource.query(
        `SELECT google_places_requests AS used FROM payee_lookup_usage
          WHERE user_id = $1`,
        [userId],
      ),
    );
    return rows.length === 0 ? 0 : Number(rows[0].used);
  };

  describe("a user's own key", () => {
    it("has exactly one winner when two claims race over the last slot", async () => {
      await withUserContext(userId, () => quota.claim(userScope(2)));

      const results = await Promise.all([
        withUserContext(userId, () => quota.claim(userScope(2))),
        withUserContext(userId, () => quota.claim(userScope(2))),
      ]);

      // One claim takes the second slot; the other is refused. Both succeeding
      // is the lost update this statement exists to prevent.
      const granted = results.filter((count) => count !== null);
      expect(granted).toHaveLength(1);
      expect(granted[0]).toBe(2);
      expect(await storedCount()).toBe(2);
    });

    it("refuses every claim once the cap is spent, however many race", async () => {
      await withUserContext(userId, () => quota.claim(userScope(1)));

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          withUserContext(userId, () => quota.claim(userScope(1))),
        ),
      );

      expect(results.every((count) => count === null)).toBe(true);
      expect(await storedCount()).toBe(1);
    });

    it("creates the month's row on the first claim and counts up from one", async () => {
      await expect(
        withUserContext(userId, () => quota.claim(userScope(10))),
      ).resolves.toBe(1);
      await expect(
        withUserContext(userId, () => quota.claim(userScope(10))),
      ).resolves.toBe(2);
    });

    it("counts without limit when the cap is switched off", async () => {
      // The counter still moves -- the settings screen reports it -- but no
      // claim is ever refused.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          withUserContext(userId, () => quota.claim(userScope(1, false))),
        ),
      );

      expect(results.every((count) => count !== null)).toBe(true);
      expect(await storedCount()).toBe(5);
    });

    it("files the claim under the current Pacific month", async () => {
      await withUserContext(userId, () => quota.claim(userScope(10)));

      const rows = await withSystemContext(() =>
        dataSource.query(
          "SELECT month FROM payee_lookup_usage WHERE user_id = $1",
          [userId],
        ),
      );
      // Pacific, not UTC: Google's free allowance resets on the first of the
      // month at midnight Pacific, so for the seven or eight hours a month when
      // the two zones disagree this assertion is the whole point rather than a
      // pedantic restatement of the implementation.
      const expected = new Intl.DateTimeFormat("en-CA", {
        timeZone: GOOGLE_PLACES_QUOTA_TIMEZONE,
        year: "numeric",
        month: "2-digit",
      })
        .format(new Date())
        .slice(0, 7);
      expect(rows[0].month.trim()).toBe(expected);
    });

    it("keeps one user's spending off another's counter", async () => {
      const other = await createTestUserDirect(dataSource);

      await withUserContext(userId, () => quota.claim(userScope(1)));
      const otherResult = await withUserContext(other.id, () =>
        quota.claim({
          kind: "user",
          userId: other.id,
          capEnabled: true,
          cap: 1,
        }),
      );

      // A shared counter would refuse the second user their first lookup.
      expect(otherResult).toBe(1);
    });

    it("hands a claimed request back, and never past zero", async () => {
      // The Test button releases the slot when Google ANSWERED with a refusal:
      // nothing was served, so nothing was billed.
      await withUserContext(userId, () => quota.claim(userScope(10)));
      await withUserContext(userId, () => quota.claim(userScope(10)));

      await withUserContext(userId, () => quota.release(userScope(10)));
      await expect(
        withUserContext(userId, () => quota.usedThisMonth(userScope(10))),
      ).resolves.toBe(1);

      // A release is a compensation, not a ledger entry: more releases than
      // claims (a month boundary crossed in between) must not mint free quota.
      await withUserContext(userId, () => quota.release(userScope(10)));
      await withUserContext(userId, () => quota.release(userScope(10)));
      await expect(
        withUserContext(userId, () => quota.usedThisMonth(userScope(10))),
      ).resolves.toBe(0);
    });

    it("frees a slot the cap was refusing, so the next claim succeeds", async () => {
      // The point of releasing: a rejected key must not spend the month. At the
      // cap the claim is refused; handing one back has to actually reopen it.
      await withUserContext(userId, () => quota.claim(userScope(1)));
      await expect(
        withUserContext(userId, () => quota.claim(userScope(1))),
      ).resolves.toBeNull();

      await withUserContext(userId, () => quota.release(userScope(1)));

      await expect(
        withUserContext(userId, () => quota.claim(userScope(1))),
      ).resolves.toBe(1);
    });

    it("reads back what it has spent this month", async () => {
      await withUserContext(userId, () => quota.claim(userScope(10)));
      await withUserContext(userId, () => quota.claim(userScope(10)));

      await expect(
        withUserContext(userId, () => quota.usedThisMonth(userScope(10))),
      ).resolves.toBe(2);
    });

    it("reports nothing spent before the first claim of the month", async () => {
      await expect(
        withUserContext(userId, () => quota.usedThisMonth(userScope(10))),
      ).resolves.toBe(0);
    });

    /**
     * The reset is the composite primary key, not a job.
     *
     * `month` is `to_char(now() AT TIME ZONE <Pacific>, 'YYYY-MM')`, evaluated by
     * PostgreSQL inside the claim, and it is half of `payee_lookup_usage`'s
     * primary key. So at the first instant of a new Pacific month the statement
     * addresses a row that does not exist yet, takes its INSERT arm and writes
     * 1 -- the cap is never consulted on that arm, and cannot be, because
     * `monthly_cap` is CHECK'd >= 1. Nothing sweeps the old row and nothing
     * has to: it is simply no longer the row anyone addresses.
     *
     * These two cases are what a scheduled reset would have been written to
     * prove, and they fail if the month ever stops being part of the key --
     * if `month` were dropped, or the claim keyed on a lifetime total, the
     * previous month's exhausted row would refuse the new month's first
     * lookup and the quota would never come back.
     */
    it("starts the new month at one, however much the previous month spent", async () => {
      // A previous month, already at the cap. Written directly because the
      // service can only ever address the current month -- which is the
      // property under test.
      await withSystemContext(() =>
        dataSource.query(
          `INSERT INTO payee_lookup_usage (user_id, month, google_places_requests)
           VALUES ($1, to_char(now() AT TIME ZONE 'America/Los_Angeles' - interval '1 month', 'YYYY-MM'), $2)`,
          [userId, 5],
        ),
      );

      // The same cap the exhausted month hit. A lifetime counter would refuse.
      await expect(
        withUserContext(userId, () => quota.claim(userScope(5))),
      ).resolves.toBe(1);
    });

    it("reports nothing spent when the only row is a previous month's", async () => {
      await withSystemContext(() =>
        dataSource.query(
          `INSERT INTO payee_lookup_usage (user_id, month, google_places_requests)
           VALUES ($1, to_char(now() AT TIME ZONE 'America/Los_Angeles' - interval '1 month', 'YYYY-MM'), $2)`,
          [userId, 5],
        ),
      );

      // What the settings card reads. Carrying last month's number forward
      // would tell the user they had spent a budget the cap has already
      // released.
      await expect(
        withUserContext(userId, () => quota.usedThisMonth(userScope(10))),
      ).resolves.toBe(0);
    });

    it("leaves the previous month's row alone when it starts the new one", async () => {
      await withSystemContext(() =>
        dataSource.query(
          `INSERT INTO payee_lookup_usage (user_id, month, google_places_requests)
           VALUES ($1, to_char(now() AT TIME ZONE 'America/Los_Angeles' - interval '1 month', 'YYYY-MM'), $2)`,
          [userId, 5],
        ),
      );
      await withUserContext(userId, () => quota.claim(userScope(5)));

      // Two rows, one per month: the new month is a new row rather than the
      // old one reset in place, so a month's spend stays auditable after it
      // ends.
      const rows = await withSystemContext(() =>
        dataSource.query(
          `SELECT month, google_places_requests AS used FROM payee_lookup_usage
            WHERE user_id = $1 ORDER BY month`,
          [userId],
        ),
      );
      expect(rows.map((r: { used: string }) => Number(r.used))).toEqual([5, 1]);
    });
  });

  /**
   * The zone the month is counted in, proven at the boundary rather than at
   * "now".
   *
   * "Files the claim under the current Pacific month" agrees with a UTC
   * implementation for all but the seven or eight hours a month when the two
   * zones name different months -- so on its own it would pass a revert to UTC
   * with probability about 0.99. These cases pin the instant instead, and fail
   * for any zone that is not Pacific.
   *
   * The expression is the one `PayeeLookupQuotaService` sends, evaluated here
   * against a fixed timestamp. It asserts the RULE rather than a call, which is
   * the only way to interrogate a boundary the service reaches once a month.
   */
  describe("the billing month boundary (Google resets at midnight Pacific)", () => {
    const monthAt = async (instant: string): Promise<string> => {
      const rows = await withSystemContext(() =>
        dataSource.query(
          "SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM') AS month",
          [instant, GOOGLE_PLACES_QUOTA_TIMEZONE],
        ),
      );
      return rows[0].month;
    };

    it("still counts against September at UTC midnight on 1 October", async () => {
      // 00:30 UTC on 1 October is 17:30 Pacific on 30 September. Google has not
      // reset the allowance yet, so neither may we -- a UTC month key would
      // hand the user a fresh cap here and bill them for every request in it.
      await expect(monthAt("2026-10-01T00:30:00Z")).resolves.toBe("2026-09");
    });

    it("rolls over at midnight Pacific, seven hours later", async () => {
      // 07:00 UTC on 1 October is 00:00 Pacific -- PDT, so UTC-7. This is the
      // instant Google's allowance resets and the instant the cap must.
      await expect(monthAt("2026-10-01T07:00:00Z")).resolves.toBe("2026-10");
    });

    it("rolls over an hour later in winter, because Pacific observes DST", async () => {
      // 1 January is PST (UTC-8), so 07:00 UTC is still 23:00 on 31 December
      // and 08:00 UTC is the new month. A hard-coded -7 or -8 offset is wrong
      // for half the year; the named zone is why this passes both ways.
      await expect(monthAt("2027-01-01T07:00:00Z")).resolves.toBe("2026-12");
      await expect(monthAt("2027-01-01T08:00:00Z")).resolves.toBe("2027-01");
    });
  });

  describe("the operator's key", () => {
    it("has exactly one winner when two users race over the last slot", async () => {
      // One operator key is one bill, so two different users' lookups compete
      // for the same counter.
      const other = await createTestUserDirect(dataSource);
      await withUserContext(userId, () => quota.claim(operatorScope(2)));

      const results = await Promise.all([
        withUserContext(userId, () => quota.claim(operatorScope(2))),
        withUserContext(other.id, () => quota.claim(operatorScope(2))),
      ]);

      expect(results.filter((count) => count !== null)).toEqual([2]);
    });

    it("starts the new month at one, however much the previous month spent", async () => {
      await withSystemContext(() =>
        dataSource.query(
          `INSERT INTO google_places_instance_usage (month, requests)
           VALUES (to_char(now() AT TIME ZONE 'America/Los_Angeles' - interval '1 month', 'YYYY-MM'), $1)`,
          [5],
        ),
      );

      // The operator's key gets its month back on the same boundary and by the
      // same mechanism as a user's -- one key is one bill, and one bill has a
      // billing month.
      await expect(
        withUserContext(userId, () => quota.claim(operatorScope(5))),
      ).resolves.toBe(1);
    });

    it("hands a claimed request back on the deployment counter too", async () => {
      await withUserContext(userId, () => quota.claim(operatorScope(10)));
      await withUserContext(userId, () => quota.release(operatorScope(10)));

      await expect(
        withUserContext(userId, () => quota.usedThisMonth(operatorScope(10))),
      ).resolves.toBe(0);
    });

    it("counts every user's lookup against the one deployment counter", async () => {
      const other = await createTestUserDirect(dataSource);

      await withUserContext(userId, () => quota.claim(operatorScope(10)));
      await withUserContext(other.id, () => quota.claim(operatorScope(10)));

      await expect(
        withUserContext(userId, () => quota.usedThisMonth(operatorScope(10))),
      ).resolves.toBe(2);
    });
  });
});
