import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "./encryption.service";

describe("EncryptionService", () => {
  let service: EncryptionService;
  let mockConfigService: Partial<Record<keyof ConfigService, jest.Mock>>;

  const VALID_KEY = "a".repeat(32);

  beforeEach(async () => {
    mockConfigService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          if (key === "ENCRYPTION_KEY") return VALID_KEY;
          return defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
  });

  describe("isConfigured()", () => {
    it("returns true when key is at least 32 characters", () => {
      expect(service.isConfigured()).toBe(true);
    });

    it("returns false when key is too short", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("short");

      const module = await Test.createTestingModule({
        providers: [
          EncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const shortKeyService = module.get<EncryptionService>(EncryptionService);
      expect(shortKeyService.isConfigured()).toBe(false);
    });

    it("returns false when key is empty", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("");

      const module = await Test.createTestingModule({
        providers: [
          EncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const emptyService = module.get<EncryptionService>(EncryptionService);
      expect(emptyService.isConfigured()).toBe(false);
    });
  });

  describe("encrypt() / decrypt()", () => {
    it("round-trips plaintext through encrypt then decrypt", () => {
      const plaintext = "sk-ant-api03-secret-key-value";
      const encrypted = service.encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(":");

      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for the same plaintext", () => {
      const plaintext = "same-key";
      const enc1 = service.encrypt(plaintext);
      const enc2 = service.encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    // Reachable: this release starts without a key (it warns instead), so a
    // deployment that has not set one meets the refusal here -- on the request
    // that tried to store a secret -- rather than at boot.
    it("throws when encryption key is not configured", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("");

      const module = await Test.createTestingModule({
        providers: [
          EncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const unconfiguredService =
        module.get<EncryptionService>(EncryptionService);
      expect(() => unconfiguredService.encrypt("test")).toThrow(
        /ENCRYPTION_KEY is not configured/,
      );
      expect(() => unconfiguredService.decrypt("test")).toThrow(
        /ENCRYPTION_KEY is not configured/,
      );
    });
  });

  describe("canDecrypt()", () => {
    /** A service holding a different master key, as another instance would. */
    async function serviceWithKey(key: string): Promise<EncryptionService> {
      const module = await Test.createTestingModule({
        providers: [
          EncryptionService,
          {
            provide: ConfigService,
            useValue: {
              get: jest
                .fn()
                .mockImplementation((name: string, fallback?: string) =>
                  name === "ENCRYPTION_KEY" ? key : fallback,
                ),
            },
          },
        ],
      }).compile();
      return module.get<EncryptionService>(EncryptionService);
    }

    it("reads back what it encrypted", () => {
      expect(service.canDecrypt(service.encrypt("sk-ant-live"))).toBe(true);
    });

    it("refuses a ciphertext produced under a different key", async () => {
      // This is the restore case: the row travels in the backup, the master key
      // does not. Without the AES-GCM auth tag this would return plausible
      // garbage instead of failing, and nothing downstream could tell.
      const other = await serviceWithKey("b".repeat(32));
      expect(service.canDecrypt(other.encrypt("sk-ant-live"))).toBe(false);
    });

    it("refuses a value that is not a ciphertext at all", () => {
      expect(service.canDecrypt("plain-text-key")).toBe(false);
    });

    it("distinguishes no key from an unreadable one", () => {
      // Both are falsy answers here, but they are different facts, and the
      // caller separates them by testing the column first -- so this asserts the
      // contract "empty in, false out" rather than letting an empty string throw.
      expect(service.canDecrypt(null)).toBe(false);
      expect(service.canDecrypt(undefined)).toBe(false);
      expect(service.canDecrypt("")).toBe(false);
    });

    it("returns false rather than throwing when no key is configured", async () => {
      const unconfigured = await serviceWithKey("");
      const ciphertext = service.encrypt("sk-ant-live");
      expect(unconfigured.canDecrypt(ciphertext)).toBe(false);
    });
  });

  describe("maskApiKey()", () => {
    it("returns null for null input", () => {
      expect(service.maskApiKey(null)).toBeNull();
    });

    it("masks long keys showing last 4 characters", () => {
      expect(service.maskApiKey("sk-ant-api03-secret-key-abcd")).toBe(
        "****abcd",
      );
    });

    it("masks short keys completely", () => {
      expect(service.maskApiKey("abc")).toBe("****");
    });

    it("masks exactly 4 char keys", () => {
      expect(service.maskApiKey("abcd")).toBe("****");
    });

    it("masks 5 char keys showing last 4", () => {
      expect(service.maskApiKey("xabcd")).toBe("****abcd");
    });
  });
});
