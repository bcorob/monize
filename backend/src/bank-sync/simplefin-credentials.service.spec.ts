import { ConfigService } from "@nestjs/config";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";
import type { DataSource } from "typeorm";
import { SimplefinCredentialsService } from "./simplefin-credentials.service";
import { SimplefinRequestBudgetService } from "./simplefin-request-budget.service";
import { BankSyncCredential } from "./entities/bank-sync-credential.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import { User } from "../users/entities/user.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { testEncryption, USER_ID } from "./bank-sync-testing";
import { INTENTIONALLY_EXCLUDED_TABLES } from "../backup/export-table-queries";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
describe("SimpleFIN encrypted credential storage", () => {
  const access =
    "https://test-user:test-password@beta-bridge.simplefin.org/simplefin/test-app";
  const repo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((value) => value),
    delete: jest.fn(),
  };
  const users = { findOne: jest.fn() };
  const connections = { update: jest.fn() };
  const { dataSource } = createScopedDbMocks([
    [BankSyncCredential, repo],
    [User, users],
    [BankSyncConnection, connections],
  ]);
  const budget: jest.Mocked<Pick<SimplefinRequestBudgetService, "status">> = {
    status: jest.fn(),
  };
  const encryption = testEncryption();
  const resolve = (userId: string) =>
    new BankSyncCredentialsService(
      dataSource as unknown as DataSource,
      encryption,
      new ConfigService(),
      {} as BankSyncProviderRegistry,
    ).resolveCredentials(userId, "simplefin");
  const build = (enc = encryption) =>
    new SimplefinCredentialsService(
      dataSource as unknown as DataSource,
      enc,
      budget as unknown as SimplefinRequestBudgetService,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    users.findOne.mockResolvedValue({ id: USER_ID });
    repo.findOne.mockResolvedValue(null);
    budget.status.mockResolvedValue({ remaining: 24, nextEligibleAt: null });
  });
  it("stores only ciphertext, with the provider-specific nullable shape", async () => {
    await build().storeClaimedAccessUrl(USER_ID, access);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      userId: USER_ID,
      provider: "simplefin",
      applicationId: null,
      privateKeyEnc: null,
    });
    expect(saved.accessUrlEnc).not.toContain("test-password");
    expect(encryption.decrypt(saved.accessUrlEnc)).toBe(access);
  });
  it("requires explicit replacement before touching the old encrypted value", async () => {
    const row = { id: "credential", accessUrlEnc: "old-ciphertext" };
    repo.findOne.mockResolvedValue(row);
    await expect(
      build().storeClaimedAccessUrl(USER_ID, access),
    ).rejects.toMatchObject({ status: 409 });
    expect(row.accessUrlEnc).toBe("old-ciphertext");
    expect(repo.save).not.toHaveBeenCalled();
  });
  it("retains credential identity when replacing so the request budget is not reset", async () => {
    const row = { id: "credential", accessUrlEnc: "old" };
    repo.findOne.mockResolvedValue(row);
    await build().storeClaimedAccessUrl(USER_ID, access, true);
    expect(repo.save.mock.calls[0][0].id).toBe("credential");
    expect(encryption.decrypt(row.accessUrlEnc)).toBe(access);
  });
  it("rejects an invalid destination before encrypting or writing", async () => {
    await expect(
      build().storeClaimedAccessUrl(USER_ID, "https://u:p@127.0.0.1/simplefin"),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.save).not.toHaveBeenCalled();
  });
  it("does not save credentials without a server encryption key", async () => {
    await expect(
      build(testEncryption(false)).storeClaimedAccessUrl(USER_ID, access),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.save).not.toHaveBeenCalled();
  });
  it("never returns credentials or ciphertext from status", async () => {
    repo.findOne.mockResolvedValue({
      id: "credential",
      accessUrlEnc: encryption.encrypt(access),
    });
    const status = await build().status(USER_ID);
    expect(status).toMatchObject({
      provider: "simplefin",
      credentialSet: true,
      capabilities: {
        setupFlow: "setup_token",
        hasConsentExpiry: false,
        supportsRemoteSessionRevocation: false,
      },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /test-password|accessUrl|access_url|ciphertext/,
    );
  });
  it("decrypts credentials only in the internal provider-call resolver", async () => {
    repo.findOne.mockResolvedValue({
      id: "credential",
      accessUrlEnc: encryption.encrypt(access),
    });
    await expect(resolve(USER_ID)).resolves.toEqual({
      provider: "simplefin",
      credentialId: "credential",
      accessUrl: access,
    });
  });
  it("does not echo ciphertext when decryption fails", async () => {
    repo.findOne.mockResolvedValue({
      id: "credential",
      accessUrlEnc: "broken-ciphertext",
    });
    await expect(resolve(USER_ID)).rejects.toThrow("Reconnect");
    try {
      await resolve(USER_ID);
    } catch (error) {
      expect((error as Error).message).not.toContain("broken-ciphertext");
    }
  });
  it("disables local institution sync before deleting only this user's SimpleFIN credential", async () => {
    repo.findOne.mockResolvedValue({ id: "credential" });
    await build().remove(USER_ID);
    expect(connections.update).toHaveBeenCalledWith(
      { userId: USER_ID, provider: "simplefin" },
      expect.objectContaining({ autoSync: false, status: "failed" }),
    );
    expect(repo.delete).toHaveBeenCalledWith({
      id: "credential",
      userId: USER_ID,
      provider: "simplefin",
    });
    expect(connections.update.mock.invocationCallOrder[0]).toBeLessThan(
      repo.delete.mock.invocationCallOrder[0],
    );
  });
  it("excludes both access credentials and request reservations from portable backups", () => {
    expect(INTENTIONALLY_EXCLUDED_TABLES.has("bank_sync_credentials")).toBe(
      true,
    );
    expect(
      INTENTIONALLY_EXCLUDED_TABLES.has("bank_sync_provider_requests"),
    ).toBe(true);
  });
});
