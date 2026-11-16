import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  OauthSigningKeysService,
  keyIds,
  type InstanceJwks,
} from "./oauth-signing-keys.service";
import { OauthInstanceConfig } from "./entities/oauth-instance-config.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("OauthSigningKeysService", () => {
  let manager: Record<string, jest.Mock>;
  let configRepo: Record<string, jest.Mock>;
  let encryption: jest.Mocked<
    Pick<EncryptionService, "isConfigured" | "encrypt" | "decrypt">
  >;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  /** Reversible stand-in: the spec asserts about key material, not about AES. */
  const seal = (plaintext: string) => `enc(${plaintext})`;
  const unseal = (ciphertext: string) => {
    const match = /^enc\(([\s\S]*)\)$/.exec(ciphertext);
    if (!match) throw new Error("bad ciphertext");
    return match[1];
  };

  async function build(): Promise<OauthSigningKeysService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OauthSigningKeysService,
        { provide: DataSource, useValue: dataSource },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();
    return module.get(OauthSigningKeysService);
  }

  beforeEach(() => {
    configRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const scoped = createScopedDbMocks([
      [OauthInstanceConfig, configRepo as never],
    ]);
    manager = scoped.manager as Record<string, jest.Mock>;
    // The insert wins by default, so the row the service re-reads is the one it
    // just wrote -- which is what an uncontended first start looks like.
    manager.query.mockImplementation(
      async (_sql: string, params: unknown[]) => {
        storeRow(params[0] as string);
        return [];
      },
    );
    dataSource = scoped.dataSource;

    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn(seal),
      decrypt: jest.fn(unseal),
    };
  });

  afterEach(() => jest.clearAllMocks());

  /** Make the repository answer as the table would once a row exists. */
  function storeRow(ciphertext: string): void {
    configRepo.findOne.mockResolvedValue({
      id: true,
      jwksEnc: ciphertext,
      generatedAt: new Date(),
    } as OauthInstanceConfig);
  }

  describe("ensureJwks on an empty database", () => {
    it("mints one RSA and one EC signing key", async () => {
      const service = await build();

      const jwks = (await service.ensureJwks()) as InstanceJwks;

      expect(jwks.keys).toHaveLength(2);
      expect(jwks.keys.map((k) => k.kty).sort()).toEqual(["EC", "RSA"]);
      // Private halves: the provider signs with these, so the stored document
      // is the whole key pair and not the public JWKS a client fetches.
      expect(jwks.keys.every((k) => typeof k.d === "string")).toBe(true);
      expect(jwks.keys.every((k) => k.use === "sig")).toBe(true);
    });

    it("gives every key a kid derived from the key itself", async () => {
      const service = await build();

      const jwks = (await service.ensureJwks()) as InstanceJwks;

      const ids = keyIds(jwks);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("stores what the encryption service returned, never the key material", async () => {
      const service = await build();

      await service.ensureJwks();

      // The column takes the ciphertext; the plaintext only ever reaches
      // `encrypt`. The private halves are in that plaintext -- anyone holding
      // them can mint an ID token this deployment vouches for.
      const [, params] = manager.query.mock.calls[0];
      expect(encryption.encrypt).toHaveBeenCalledTimes(1);
      const plaintext = encryption.encrypt.mock.calls[0][0];
      expect(JSON.parse(plaintext).keys[0].d).toEqual(expect.any(String));
      expect(params[0]).toBe(seal(plaintext));
      expect(params[0]).not.toBe(plaintext);
    });

    // Several replicas run the provider's init at once. The insert has to be
    // the arbiter, and the loser must take the winner's keys -- not the ones it
    // generated and failed to store.
    it("lets the insert arbitrate and re-reads the stored row", async () => {
      const service = await build();
      const winner: InstanceJwks = {
        keys: [{ kty: "RSA", kid: "winner", use: "sig", n: "n", e: "AQAB" }],
      };
      // This replica lost the race: the row it re-reads is the winner's.
      manager.query.mockImplementation(async () => {
        storeRow(seal(JSON.stringify(winner)));
        return [];
      });

      const jwks = await service.ensureJwks();

      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(jwks).toEqual(winner);
      expect(keyIds(jwks!)).toEqual(["winner"]);
    });
  });

  describe("ensureJwks with a row already present", () => {
    it("returns the stored keys and writes nothing", async () => {
      const stored: InstanceJwks = {
        keys: [{ kty: "EC", kid: "already", use: "sig", crv: "P-256" }],
      };
      storeRow(seal(JSON.stringify(stored)));
      const service = await build();

      await expect(service.ensureJwks()).resolves.toEqual(stored);
      expect(manager.query).not.toHaveBeenCalled();
      expect(encryption.encrypt).not.toHaveBeenCalled();
    });

    // Two processes over one database is the whole point: the same document,
    // so the same `kid`s, so a token minted by either verifies against either.
    it("gives two instances over one database the same kids", async () => {
      const stored: InstanceJwks = {
        keys: [{ kty: "RSA", kid: "shared", use: "sig", n: "n", e: "AQAB" }],
      };
      storeRow(seal(JSON.stringify(stored)));

      const first = await (await build()).ensureJwks();
      const second = await (await build()).ensureJwks();

      expect(keyIds(first!)).toEqual(keyIds(second!));
    });
  });

  describe("without a usable encryption key", () => {
    it("stores nothing and returns null", async () => {
      encryption.isConfigured.mockReturnValue(false);
      const service = await build();

      await expect(service.ensureJwks()).resolves.toBeNull();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("cannot read a row it has, and says so rather than guessing", async () => {
      storeRow(seal('{"keys":[]}'));
      encryption.isConfigured.mockReturnValue(false);
      const service = await build();

      await expect(service.readJwks()).resolves.toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    // A database restored onto an instance with a different ENCRYPTION_KEY.
    // AES-GCM authenticates, so this raises rather than yielding plausible
    // bytes; falling back beats refusing to start the whole OAuth surface.
    it("falls back when the stored keys do not decrypt", async () => {
      storeRow("written-under-another-key");
      encryption.decrypt.mockImplementation(() => {
        throw new Error("Unsupported state or unable to authenticate data");
      });
      const service = await build();

      await expect(service.readJwks()).resolves.toBeNull();
    });
  });
});
