import { DataSource } from "typeorm";

import {
  FetchSyncJob,
  FetchSyncService,
} from "@/common/jobs/fetch-sync.service";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The fetch lease against a real database.
 *
 * Every property here belongs to PostgreSQL rather than to the service: the
 * primary key decides who wins, the `DO UPDATE ... WHERE` arm decides whether an
 * existing lease may be retaken, and the token in the predicate decides whether
 * a late worker may write. A mocked manager can return whatever it is told to
 * and demonstrate none of it, so the race below is on **two separate
 * connections** (VER-001, `docs/verification-contract.md`).
 *
 * This lease is a cost control, not a correctness mechanism -- the fetches it
 * guards write idempotent upserts -- so "a lost lease never blocks the next
 * tick" is as much a requirement as "only one winner", and both are tested.
 */
describe("FetchSyncService (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let serviceA: FetchSyncService;
  let serviceB: FetchSyncService;

  const JOB = FetchSyncJob.ExchangeRates;
  const LEASE_MS = 15 * 60 * 1000;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    serviceA = new FetchSyncService(dataSourceA);
    serviceB = new FetchSyncService(dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM fetch_sync");
  });

  const expireLease = () =>
    dataSourceA.query(
      `UPDATE fetch_sync
          SET lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE job = $1`,
      [JOB],
    );

  it("gives one token to two connections claiming one job", async () => {
    const tokens = await withSystemContext(() =>
      Promise.all([
        serviceA.claim(JOB, LEASE_MS),
        serviceB.claim(JOB, LEASE_MS),
      ]),
    );

    expect(tokens.filter(Boolean)).toHaveLength(1);

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM fetch_sync WHERE job = $1",
      [JOB],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a second claim while the lease is live", async () => {
    await expect(
      withSystemContext(() => serviceA.claim(JOB, LEASE_MS)),
    ).resolves.toEqual(expect.any(String));
    await expect(
      withSystemContext(() => serviceB.claim(JOB, LEASE_MS)),
    ).resolves.toBeNull();
  });

  // A replica killed mid-fetch holds nothing anyone has to clean up: the expiry
  // alone hands the job back, which is what makes this safe as a cost control.
  it("lets a later claim win once lease_until has passed", async () => {
    await withSystemContext(() => serviceA.claim(JOB, LEASE_MS));
    await expireLease();

    await expect(
      withSystemContext(() => serviceB.claim(JOB, LEASE_MS)),
    ).resolves.toEqual(expect.any(String));
  });

  it("is a no-op to release with the wrong token", async () => {
    const held = await withSystemContext(() => serviceA.claim(JOB, LEASE_MS));

    // The stalled holder of a lease B has since retaken tries to tidy up.
    await withSystemContext(() =>
      serviceB.release(JOB, "00000000-0000-4000-8000-000000000000"),
    );

    const [row]: { lease_token: string | null }[] = await dataSourceA.query(
      "SELECT lease_token FROM fetch_sync WHERE job = $1",
      [JOB],
    );
    expect(row.lease_token).toBe(held);
  });

  it("is a no-op to record success with the wrong token", async () => {
    await withSystemContext(() => serviceA.claim(JOB, LEASE_MS));

    await withSystemContext(() =>
      serviceB.markSuccess(JOB, "00000000-0000-4000-8000-000000000000"),
    );

    const [row]: { last_success_at: Date | null }[] = await dataSourceA.query(
      "SELECT last_success_at FROM fetch_sync WHERE job = $1",
      [JOB],
    );
    expect(row.last_success_at).toBeNull();
  });

  it("frees the job for the next tick once the holder succeeds", async () => {
    const token = await withSystemContext(() => serviceA.claim(JOB, LEASE_MS));
    await withSystemContext(() => serviceA.markSuccess(JOB, token!));

    await expect(
      withSystemContext(() => serviceB.claim(JOB, LEASE_MS)),
    ).resolves.toEqual(expect.any(String));

    const [row]: { last_success_at: Date | null }[] = await dataSourceA.query(
      "SELECT last_success_at FROM fetch_sync WHERE job = $1",
      [JOB],
    );
    expect(row.last_success_at).not.toBeNull();
  });

  it("keeps the three jobs independent", async () => {
    await expect(
      withSystemContext(() =>
        serviceA.claim(FetchSyncJob.ExchangeRates, LEASE_MS),
      ),
    ).resolves.toEqual(expect.any(String));
    // One replica fetching FX must not stop another fetching prices: the three
    // hit different provider endpoints and are staggered on purpose.
    await expect(
      withSystemContext(() =>
        serviceB.claim(FetchSyncJob.SecurityPrices, LEASE_MS),
      ),
    ).resolves.toEqual(expect.any(String));
    await expect(
      withSystemContext(() =>
        serviceB.claim(FetchSyncJob.MarketIndexes, LEASE_MS),
      ),
    ).resolves.toEqual(expect.any(String));
  });

  it("runs the body once across two replicas' withLease", async () => {
    // Two replicas on one tick overlap: the loser's claim lands while the
    // winner is still fetching. The body therefore holds the lease until both
    // claims have come back. An instant body let the winner claim, run and
    // release (markSuccess frees the lease for the next tick) before the other
    // claim reached PostgreSQL, which then rightly took the free lease -- two
    // sequential ticks, not the race this test is about, and a CI flake.
    let claimsSettled = 0;
    let releaseBody!: () => void;
    const bothClaimsSettled = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const spies = [serviceA, serviceB].map((service) => {
      const claim = service.claim.bind(service);
      return jest
        .spyOn(service, "claim")
        .mockImplementation(async (job, leaseMs) => {
          // Counted in `finally` so a claim that throws still releases the
          // winner's body: the test then fails on that error instead of
          // leaving the body awaiting a claim that never settles.
          try {
            return await claim(job, leaseMs);
          } finally {
            if (++claimsSettled === 2) releaseBody();
          }
        });
    });

    let runs = 0;
    const body = async () => {
      runs++;
      await bothClaimsSettled;
    };

    try {
      const outcomes = await withSystemContext(() =>
        Promise.all([
          serviceA.withLease(JOB, LEASE_MS, body),
          serviceB.withLease(JOB, LEASE_MS, body),
        ]),
      );

      // Provider calls per tick go from N to 1, which is the acceptance for C2.
      expect(runs).toBe(1);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("releases the lease when the body throws", async () => {
    await expect(
      withSystemContext(() =>
        serviceA.withLease(JOB, LEASE_MS, () =>
          Promise.reject(new Error("provider down")),
        ),
      ),
    ).rejects.toThrow("provider down");

    // A failed fetch must never hold the job for the rest of its window.
    await expect(
      withSystemContext(() => serviceB.claim(JOB, LEASE_MS)),
    ).resolves.toEqual(expect.any(String));

    const [row]: { last_error: string | null }[] = await dataSourceA.query(
      "SELECT last_error FROM fetch_sync WHERE job = $1",
      [JOB],
    );
    expect(row.last_error).toContain("provider down");
  });
});
