import { DataSource } from "typeorm";
import { getActiveScopedManager } from "../common/db/scoped-db";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { SimplefinCredentialsService } from "./simplefin-credentials.service";
import { SimplefinClient } from "./providers/simplefin/simplefin.client";
import {
  SimplefinSetupService,
  SIMPLEFIN_SETUP_LEASE_KEY,
} from "./simplefin-setup.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("SimpleFIN durable setup coordinator", () => {
  const user = "00000000-0000-4000-8000-000000000001";
  const token = Buffer.from(
    "https://bridge.simplefin.org/simplefin/claim/unit-token",
  ).toString("base64");
  const access =
    "https://secret-user:secret-password@bridge.simplefin.org/simplefin/test";
  const { dataSource, manager } = createScopedDbMocks();
  const claims: jest.Mocked<
    Pick<JobClaimService, "claimLease" | "claimOnce" | "releaseLease">
  > = {
    claimLease: jest.fn(),
    claimOnce: jest.fn(),
    releaseLease: jest.fn(),
  };
  const credentials: jest.Mocked<
    Pick<
      SimplefinCredentialsService,
      "status" | "storeClaimedAccessUrl" | "remove"
    >
  > = {
    status: jest.fn(),
    remove: jest.fn(),
    storeClaimedAccessUrl: jest.fn(),
  };
  const client: jest.Mocked<Pick<SimplefinClient, "claim">> = {
    claim: jest.fn(),
  };
  const service = () =>
    new SimplefinSetupService(
      dataSource as unknown as DataSource,
      claims as unknown as JobClaimService,
      credentials as unknown as SimplefinCredentialsService,
      client as unknown as SimplefinClient,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getActiveScopedManager).mockReturnValue(undefined);
    claims.claimLease.mockResolvedValue("lease-token");
    claims.claimOnce.mockResolvedValue(true);
    claims.releaseLease.mockResolvedValue(undefined);
    credentials.status.mockResolvedValue({
      provider: "simplefin",
      credentialSet: false,
      encryptionAvailable: true,
      capabilities: {
        setupFlow: "setup_token",
        hasConsentExpiry: false,
        supportsRemoteSessionRevocation: false,
      },
      quota: null,
    });
    credentials.storeClaimedAccessUrl.mockResolvedValue(undefined);
    client.claim.mockResolvedValue(access);
    credentials.remove.mockResolvedValue(undefined);
    manager.query.mockResolvedValue([{ id: "lease" }]);
  });

  it("claims once, stores under the fenced lease, and returns no secret", async () => {
    await expect(service().connect(user, token)).resolves.toBeUndefined();
    expect(claims.claimOnce).toHaveBeenCalledWith(
      JobClaimType.SimplefinSetup,
      user,
      expect.stringMatching(/^token:[a-f0-9]{64}$/),
    );
    expect(client.claim.mock.invocationCallOrder[0]).toBeGreaterThan(
      claims.claimOnce.mock.invocationCallOrder[0],
    );
    expect(credentials.storeClaimedAccessUrl).toHaveBeenCalledWith(
      user,
      access,
      false,
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [
        JobClaimType.SimplefinSetup,
        user,
        SIMPLEFIN_SETUP_LEASE_KEY,
        "lease-token",
      ],
    );
    expect(claims.releaseLease).toHaveBeenCalledWith(
      JobClaimType.SimplefinSetup,
      user,
      SIMPLEFIN_SETUP_LEASE_KEY,
      "lease-token",
    );
  });

  it("refuses invalid tokens before acquiring a lease", async () => {
    await expect(service().connect(user, "invalid")).rejects.toMatchObject({
      status: 400,
    });
    expect(claims.claimLease).not.toHaveBeenCalled();
    expect(client.claim).not.toHaveBeenCalled();
  });

  it("refuses an ambient transaction before making durable claims", async () => {
    jest.mocked(getActiveScopedManager).mockReturnValue(manager as never);
    await expect(service().connect(user, token)).rejects.toThrow(
      "outside an active",
    );
    expect(claims.claimLease).not.toHaveBeenCalled();
  });

  it("does not call Bridge when another worker holds the lease", async () => {
    claims.claimLease.mockResolvedValue(null);
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 409,
    });
    expect(client.claim).not.toHaveBeenCalled();
    expect(claims.releaseLease).not.toHaveBeenCalled();
  });

  it("requires replacement confirmation before spending the token", async () => {
    credentials.status.mockResolvedValue({
      ...(await credentials.status(user)),
      credentialSet: true,
    });
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 409,
    });
    expect(claims.claimOnce).not.toHaveBeenCalled();
    expect(client.claim).not.toHaveBeenCalled();
    expect(claims.releaseLease).toHaveBeenCalled();
  });

  it("passes explicit replacement confirmation to the atomic credential save", async () => {
    await service().connect(user, token, true);
    expect(credentials.storeClaimedAccessUrl).toHaveBeenCalledWith(
      user,
      access,
      true,
    );
  });

  it("refuses setup without encryption before spending the token", async () => {
    credentials.status.mockResolvedValue({
      ...(await credentials.status(user)),
      encryptionAvailable: false,
    });
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 400,
    });
    expect(claims.claimOnce).not.toHaveBeenCalled();
  });

  it("never replays an already attempted token", async () => {
    claims.claimOnce.mockResolvedValue(false);
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 409,
    });
    expect(client.claim).not.toHaveBeenCalled();
  });

  it("reports an uncertain claim without leaking the underlying error or replaying it", async () => {
    client.claim.mockRejectedValue(new Error(access + token));
    const error = await service()
      .connect(user, token)
      .catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain("secret-password");
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error).toMatchObject({
      status: 503,
      message: expect.stringContaining("may have been consumed"),
    });
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(credentials.storeClaimedAccessUrl).not.toHaveBeenCalled();
    expect(claims.releaseLease).toHaveBeenCalled();
  });

  it("refuses to save when the lease expired or was retaken", async () => {
    manager.query.mockResolvedValue([]);
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("could not confirm saving"),
    });
    expect(credentials.storeClaimedAccessUrl).not.toHaveBeenCalled();
  });

  it("distinguishes consumed-token storage failure from a failed claim", async () => {
    credentials.storeClaimedAccessUrl.mockRejectedValue(new Error(access));
    await expect(service().connect(user, token)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("consumed"),
    });
    expect(client.claim).toHaveBeenCalledTimes(1);
  });

  it("does not turn committed success into failure when lease cleanup fails", async () => {
    claims.releaseLease.mockRejectedValue(new Error("database unavailable"));
    await expect(service().connect(user, token)).resolves.toBeUndefined();
  });
  it("removes locally under the fenced setup lease", async () => {
    await service().disconnect(user);
    expect(credentials.remove).toHaveBeenCalledWith(user);
    expect(client.claim).not.toHaveBeenCalled();
    expect(claims.releaseLease).toHaveBeenCalled();
  });

  it("refuses removal while another setup holds the lease", async () => {
    claims.claimLease.mockResolvedValue(null);
    await expect(service().disconnect(user)).rejects.toMatchObject({
      status: 409,
    });
    expect(credentials.remove).not.toHaveBeenCalled();
  });

  it("refuses removal by a stale lease holder", async () => {
    manager.query.mockResolvedValue([]);
    await expect(service().disconnect(user)).rejects.toMatchObject({
      status: 409,
    });
    expect(credentials.remove).not.toHaveBeenCalled();
  });
});
