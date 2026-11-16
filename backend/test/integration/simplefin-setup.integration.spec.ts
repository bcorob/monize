import { SimplefinNotDispatchedError } from "@/bank-sync/providers/simplefin/simplefin.client";
import { ConfigService } from "@nestjs/config";
import { BankSyncCredentialsService } from "@/bank-sync/bank-sync-credentials.service";
import { BankSyncProviderRegistry } from "@/bank-sync/providers/bank-sync-provider.registry";
import { SimplefinCredentialsService } from "@/bank-sync/simplefin-credentials.service";
import { SimplefinRequestBudgetService } from "@/bank-sync/simplefin-request-budget.service";
import { SimplefinSetupService } from "@/bank-sync/simplefin-setup.service";
import { SimplefinClient } from "@/bank-sync/providers/simplefin/simplefin.client";
import { testEncryption } from "@/bank-sync/bank-sync-testing";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { withScopedDb, getActiveScopedManager } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("SimpleFIN setup leases on PostgreSQL with enforced RLS", () => {
  let harness: EnforcedIntegrationHarness;
  let alice: string;
  let bob: string;
  let claims: JobClaimService;
  let storage: SimplefinCredentialsService;
  let credentials: BankSyncCredentialsService;
  let service: SimplefinSetupService;
  const client: jest.Mocked<Pick<SimplefinClient, "claim">> = {
    claim: jest.fn(),
  };
  const access =
    "https://first-user:first-password@bridge.simplefin.org/simplefin/test";
  const replacement =
    "https://second-user:second-password@bridge.simplefin.org/simplefin/test";
  const token = (id: string) =>
    Buffer.from("https://bridge.simplefin.org/simplefin/claim/" + id).toString(
      "base64",
    );
  const scoped = <T>(id: string, fn: () => Promise<T>) =>
    withUserContext(id, fn);
  const resolve = () =>
    scoped(alice, () => credentials.resolveCredentials(alice, "simplefin"));

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    alice = (
      await createTestUserDirect(harness.owner, {
        email: "sf-setup-alice@example.com",
      })
    ).id;
    bob = (
      await createTestUserDirect(harness.owner, {
        email: "sf-setup-bob@example.com",
      })
    ).id;
    claims = new JobClaimService(harness.app);
    storage = new SimplefinCredentialsService(
      harness.app,
      testEncryption(),
      new SimplefinRequestBudgetService(harness.app),
    );
    credentials = new BankSyncCredentialsService(
      harness.app,
      testEncryption(),
      new ConfigService(),
      {} as BankSyncProviderRegistry,
    );
    service = new SimplefinSetupService(
      harness.app,
      claims,
      storage,
      client as unknown as SimplefinClient,
    );
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    client.claim.mockReset().mockResolvedValue(access);
    await harness.owner.query("DELETE FROM job_claims");
    await harness.owner.query("DELETE FROM bank_sync_credentials");
  });

  it("commits lease and hashed attempt before HTTP, without holding a transaction", async () => {
    client.claim.mockImplementation(async () => {
      expect(getActiveScopedManager()).toBeUndefined();
      const rows = await harness.owner.query(
        "SELECT claim_key FROM job_claims WHERE user_id=$1",
        [alice],
      );
      expect(rows).toHaveLength(2);
      expect(
        rows.some((r: { claim_key: string }) =>
          /^token:[a-f0-9]{64}$/.test(r.claim_key),
        ),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(token("one"));
      return access;
    });
    await scoped(alice, () => service.connect(alice, token("one")));
    expect((await resolve()).accessUrl).toBe(access);
    const stored = await harness.owner.query(
      "SELECT access_url_enc FROM bank_sync_credentials WHERE user_id=$1",
      [alice],
    );
    expect(stored[0].access_url_enc).not.toContain("first-password");
  });

  it("admits only one of two workers while a claim is in flight", async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      started = resolveReady;
    });
    client.claim.mockImplementation(() => {
      started();
      return new Promise<string>((resolveClaim) => {
        release = resolveClaim;
      });
    });
    const first = scoped(alice, () => service.connect(alice, token("first")));
    await ready;
    try {
      await expect(
        scoped(alice, () => service.connect(alice, token("second"))),
      ).rejects.toMatchObject({ status: 409 });
      expect(client.claim).toHaveBeenCalledTimes(1);
    } finally {
      release(access);
      await first;
    }
  });

  it("keeps an ambiguous token attempt durable and never replays it", async () => {
    client.claim.mockRejectedValue(new Error("simulated timeout"));
    await expect(
      scoped(alice, () => service.connect(alice, token("uncertain"))),
    ).rejects.toMatchObject({ status: 503 });
    client.claim.mockResolvedValue(access);
    await expect(
      scoped(alice, () => service.connect(alice, token("uncertain"))),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.claim).toHaveBeenCalledTimes(1);
    await expect(resolve()).rejects.toMatchObject({ status: 400 });
  });

  it("preserves the old credential when the replacement claim fails", async () => {
    await scoped(alice, () => storage.storeClaimedAccessUrl(alice, access));
    client.claim.mockRejectedValue(new Error("simulated timeout"));
    await expect(
      scoped(alice, () => service.connect(alice, token("replace"), true)),
    ).rejects.toMatchObject({ status: 503 });
    expect((await resolve()).accessUrl).toBe(access);
  });

  it("rejects unconfirmed replacement before attempting its token", async () => {
    await scoped(alice, () => storage.storeClaimedAccessUrl(alice, access));
    await expect(
      scoped(alice, () => service.connect(alice, token("confirm"))),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.claim).not.toHaveBeenCalled();
    await scoped(alice, () => service.connect(alice, token("confirm"), true));
    expect(client.claim).toHaveBeenCalledTimes(1);
  });

  it("fences an expired former holder after a second worker replaces its lease", async () => {
    await scoped(alice, () => storage.storeClaimedAccessUrl(alice, access));
    const realLease = claims.claimLease.bind(claims);
    jest
      .spyOn(claims, "claimLease")
      .mockImplementationOnce((type, id, key) => realLease(type, id, key, 1));
    let release!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      started = resolveReady;
    });
    client.claim
      .mockImplementationOnce(() => {
        started();
        return new Promise<string>((resolveClaim) => {
          release = resolveClaim;
        });
      })
      .mockResolvedValue(replacement);
    const first = scoped(alice, () =>
      service.connect(alice, token("expired"), true),
    );
    const firstResult = expect(first).rejects.toMatchObject({ status: 503 });
    await ready;
    await new Promise((done) => setTimeout(done, 20));
    try {
      await scoped(alice, () =>
        service.connect(alice, token("new-holder"), true),
      );
    } finally {
      release(access);
      await firstResult;
    }
    expect((await resolve()).accessUrl).toBe(replacement);
  });

  it("keeps another owner's lease and attempt markers hidden under RLS", async () => {
    await scoped(alice, () => service.connect(alice, token("rls")));
    expect(
      await scoped(bob, () =>
        withScopedDb(harness.app, (m) => m.query("SELECT id FROM job_claims")),
      ),
    ).toEqual([]);
  });

  it("refuses an outer transaction before any claim or HTTP", async () => {
    await expect(
      scoped(alice, () =>
        withScopedDb(harness.app, () => service.connect(alice, token("outer"))),
      ),
    ).rejects.toThrow("outside an active");
    expect(client.claim).not.toHaveBeenCalled();
  });
  it("makes a proven unsent token retryable while retaining ambiguous-send protection", async () => {
    client.claim
      .mockRejectedValueOnce(new SimplefinNotDispatchedError("transport"))
      .mockResolvedValueOnce(access);
    const value = token("unsent");
    await expect(
      scoped(alice, () => service.connect(alice, value)),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("not sent"),
    });
    await expect(
      scoped(alice, () => service.connect(alice, value)),
    ).resolves.toBeUndefined();
    expect((await resolve()).accessUrl).toBe(access);
  });
  it("does not let an expired worker remove its token fence", async () => {
    client.claim.mockImplementationOnce(async () => {
      await harness.owner.query(
        "UPDATE job_claims SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE claim_key='setup'",
      );
      throw new SimplefinNotDispatchedError("transport");
    });
    const value = token("stale-unsent");
    await expect(
      scoped(alice, () => service.connect(alice, value)),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      scoped(alice, () => service.connect(alice, value)),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.claim).toHaveBeenCalledTimes(1);
  });
});
