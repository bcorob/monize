import * as webpush from "web-push";
import { EntityManager } from "typeorm";
import { withSystemContext } from "../common/db/with-context";
import { PushConfigService } from "./push-config.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PushInstanceConfig } from "./entities/push-instance-config.entity";

/**
 * The bootstrap hook against the REAL `withScopedDb`.
 *
 * `push-config.service.spec.ts` mocks that module away, which is right for
 * everything it asserts and structurally blind to exactly one thing: whether a
 * caller has an ambient identity context at all. The real `withScopedDb` throws
 * without one, `onApplicationBootstrap` swallows the throw, and the deployment
 * is then left permanently without a key pair while the admin page blames a
 * missing ENCRYPTION_KEY -- a whole feature dead, silently, with every unit test
 * green. This suite is the same shape as `rls-context-smoke.spec.ts`, and it
 * needs no database: the identity check runs before the DataSource is touched,
 * and a stub `transaction` is enough for the rest.
 */

jest.mock("web-push", () => ({
  generateVAPIDKeys: jest.fn(),
  sendNotification: jest.fn(),
}));

const generateVAPIDKeys = webpush.generateVAPIDKeys as jest.Mock;

describe("PushConfigService bootstrap (real withScopedDb)", () => {
  let service: PushConfigService;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let configRepo: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    configRepo = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      query: jest.fn().mockResolvedValue([[], 0]),
      getRepository: jest.fn(() => configRepo),
    };
    dataSource = {
      transaction: jest.fn((fn: (m: EntityManager) => unknown) =>
        fn(manager as unknown as EntityManager),
      ),
    };
    generateVAPIDKeys.mockReturnValue({
      publicKey: "PUB-NEW",
      privateKey: "PRIV-NEW",
    });
    service = new PushConfigService(
      dataSource as never,
      {
        isConfigured: () => true,
        encrypt: (plain: string) => `enc(${plain})`,
        decrypt: (cipher: string) => cipher,
        canDecrypt: () => true,
      } as unknown as EncryptionService,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  it("seeds its own identity context, so the very first read does not throw", async () => {
    // No request, no interceptor, no ambient context -- exactly the hook's world.
    await expect(service.ensureKeyPair()).resolves.not.toBeUndefined();

    expect(configRepo.findOne).toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO push_instance_config"),
      ["PUB-NEW", "enc(PRIV-NEW)"],
    );
  });

  it("generates the key pair when the hook runs it", async () => {
    await service.onApplicationBootstrap();

    // The assertion that matters: the hook swallows failures by design, so
    // "did not throw" proves nothing. The write is what proves it worked.
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(service["logger"].error).not.toHaveBeenCalled();
  });

  it("reuses an existing pair rather than minting one per restart", async () => {
    configRepo.findOne.mockResolvedValue({
      id: true,
      vapidPublicKey: "PUB-STORED",
    } as PushInstanceConfig);

    const result = await service.ensureKeyPair();

    expect(result?.vapidPublicKey).toBe("PUB-STORED");
    expect(generateVAPIDKeys).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  /**
   * The reuse branch is the NORMAL one -- every restart after the first -- and it
   * used to return the row without touching the identity, leaving the memo cold.
   * The first `GET /push/config` then paid the decryption, whose derivation is
   * `scryptSync`: tens of milliseconds of blocked event loop, for every
   * concurrent request, on whichever request happened to arrive first. Warming
   * it here is what the hook is for.
   */
  it("warms the identity memo on the reuse branch, so no request pays for it", async () => {
    const decrypt = jest.fn((cipher: string) => cipher);
    service = new PushConfigService(
      dataSource as never,
      {
        isConfigured: () => true,
        encrypt: (plain: string) => `enc(${plain})`,
        decrypt,
        canDecrypt: () => true,
      } as unknown as EncryptionService,
    );
    configRepo.findOne.mockResolvedValue({
      id: true,
      vapidPublicKey: "PUB-STORED",
      vapidPrivateKeyEnc: "enc(PRIV-STORED)",
    } as PushInstanceConfig);

    await service.ensureKeyPair();
    expect(decrypt).toHaveBeenCalledTimes(1);

    // And the memo is what answers afterwards: a second read decrypts nothing.
    // Through a context of its own, because this file runs the REAL
    // withScopedDb and a public read has no hook seeding one for it.
    await withSystemContext(() => service.getPublicConfig());
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  /**
   * And on the branch a first-ever start actually takes. Warming only the reuse
   * branch was a fix written from the restart case: the deployment that has
   * never decrypted this key -- the one with no memo at all -- still paid the
   * `scryptSync` on its first request.
   */
  it("warms the memo on the branch that generates the key pair", async () => {
    const decrypt = jest.fn((cipher: string) => cipher);
    service = new PushConfigService(
      dataSource as never,
      {
        isConfigured: () => true,
        encrypt: (plain: string) => `enc(${plain})`,
        decrypt,
        canDecrypt: () => true,
      } as unknown as EncryptionService,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    // Nothing stored, then the row as the insert leaves it.
    configRepo.findOne.mockResolvedValueOnce(null).mockResolvedValue({
      id: true,
      vapidPublicKey: "PUB-NEW",
      vapidPrivateKeyEnc: "enc(PRIV-NEW)",
    } as PushInstanceConfig);

    await service.ensureKeyPair();
    expect(generateVAPIDKeys).toHaveBeenCalled();
    expect(decrypt).toHaveBeenCalledTimes(1);

    await withSystemContext(() => service.getPublicConfig());
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});
