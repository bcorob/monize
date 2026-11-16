import { DataSource } from "typeorm";

import { JobClaimService, JobClaimType } from "@/common/jobs/job-claim.service";
import { rolloverMonthKey } from "@/budgets/budget-period-cron.service";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * One owner's month rolls over once, whichever replica gets there first.
 *
 * The claim is `INSERT ... ON CONFLICT DO NOTHING RETURNING` on
 * `idx_job_claims_key`, so "exactly one winner" is a property of that unique
 * index and not of the service -- which means two real connections have to race
 * it (VER-001, `docs/verification-contract.md`). A mocked repository told to
 * return true once proves only that the caller reads the answer.
 *
 * The rollover's own writes are not re-tested here; they have their own specs,
 * and the claim sits in front of them precisely so the loser never reaches
 * them.
 */
describe("budget period rollover claim (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let claimsA: JobClaimService;
  let claimsB: JobClaimService;
  let ownerId: string;
  let otherOwnerId: string;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    claimsA = new JobClaimService(dataSourceA);
    claimsB = new JobClaimService(dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await cleanTables(dataSourceA, ["job_claims", "users"]);
    ownerId = (
      await createTestUserDirect(dataSourceA, { email: "owner@example.com" })
    ).id;
    otherOwnerId = (
      await createTestUserDirect(dataSourceA, { email: "other@example.com" })
    ).id;
  });

  const claim = (claims: JobClaimService, userId: string, month: string) =>
    withUserContext(userId, () =>
      claims.claimOnce(JobClaimType.BudgetPeriodRollover, userId, month),
    );

  it("gives one winner to two replicas claiming one owner and month", async () => {
    const month = rolloverMonthKey(new Date());

    const results = await Promise.all([
      claim(claimsA, ownerId, month),
      claim(claimsB, ownerId, month),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM job_claims WHERE claim_type = $1 AND user_id = $2",
      [JobClaimType.BudgetPeriodRollover, ownerId],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a second claim for the same owner and month, later too", async () => {
    const month = rolloverMonthKey(new Date());

    await expect(claim(claimsA, ownerId, month)).resolves.toBe(true);
    // The claim is permanent: a month that has rolled over must never roll over
    // again, and it is deliberately not released on failure -- the request path
    // (`getOrCreateCurrentPeriod`) is what repairs a missed period.
    await expect(claim(claimsB, ownerId, month)).resolves.toBe(false);
  });

  it("keeps one owner's claim clear of another's", async () => {
    const month = rolloverMonthKey(new Date());

    await expect(claim(claimsA, ownerId, month)).resolves.toBe(true);
    await expect(claim(claimsB, otherOwnerId, month)).resolves.toBe(true);
  });

  it("lets the next month claim again", async () => {
    await expect(claim(claimsA, ownerId, "2026-01")).resolves.toBe(true);
    await expect(claim(claimsB, ownerId, "2026-02")).resolves.toBe(true);
  });

  // Two replicas in two zones must derive one key from one instant, or the
  // claim names two months and both of them run.
  it("derives the month key in UTC", () => {
    // 23:30 on the 31st in UTC-07:00 is already the 1st of the next month in
    // UTC; both replicas must agree, and UTC is the tie-breaker.
    expect(rolloverMonthKey(new Date("2026-02-01T06:30:00.000Z"))).toBe(
      "2026-02",
    );
    expect(rolloverMonthKey(new Date("2026-01-31T23:59:59.000Z"))).toBe(
      "2026-01",
    );
  });
});
