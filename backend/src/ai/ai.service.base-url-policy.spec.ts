import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { AiService } from "./ai.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiUsageService } from "./ai-usage.service";
import { AiRelayService } from "./relay/ai-relay.service";
import { User } from "../users/entities/user.entity";
import { AiBaseUrlRefusedError } from "./ai-base-url-policy";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * Which base URLs a provider's owner may use, at save, at test and at use.
 *
 * Every URL here is an IP literal, so the strict check decides without a DNS
 * lookup; the connection-time half (a NAME that resolves privately) is proved
 * on a real socket in `providers/provider-egress.spec.ts`.
 */
describe("AiService base URL policy", () => {
  const userId = "user-1";
  const PRIVATE_URL = "http://192.168.1.100:11434";
  const PUBLIC_URL = "http://8.8.8.8:11434";

  let service: AiService;
  let configRepo: Record<string, jest.Mock>;
  let userRepo: Record<string, jest.Mock>;
  let createProvider: jest.Mock;
  let configGet: jest.Mock;
  const originalAllowlist = process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;

  const okProvider = () => ({
    name: "ollama",
    supportsToolUse: true,
    isAvailable: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue({
      content: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "llama3",
      provider: "ollama",
    }),
  });

  function storedConfig(
    overrides: Partial<AiProviderConfig> = {},
  ): AiProviderConfig {
    const config = new AiProviderConfig();
    Object.assign(config, {
      id: "config-1",
      userId,
      provider: "ollama",
      displayName: null,
      isActive: true,
      priority: 0,
      model: "llama3",
      apiKeyEnc: null,
      baseUrl: PRIVATE_URL,
      config: {},
      inputCostPer1M: null,
      outputCostPer1M: null,
      costCurrency: "USD",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      ...overrides,
    });
    return config;
  }

  function ownerRole(role: "admin" | "user"): void {
    userRepo.findOne.mockResolvedValue({ id: userId, role });
  }

  beforeEach(async () => {
    delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    configRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          ...data,
          id: data.id || "new-id",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      ),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: userId, role: "user" }),
    };
    createProvider = jest.fn().mockImplementation(() => okProvider());
    configGet = jest.fn().mockReturnValue(undefined);

    const scoped = createScopedDbMocks([
      [AiProviderConfig, configRepo],
      [User, userRepo],
    ]);
    scoped.manager.query.mockResolvedValue([{ id: userId }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: DataSource, useValue: scoped.dataSource },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: jest.fn().mockReturnValue("enc"),
            decrypt: jest.fn().mockReturnValue("key"),
            canDecrypt: jest.fn().mockReturnValue(true),
            isConfigured: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AiProviderFactory, useValue: { createProvider } },
        {
          provide: AiUsageService,
          useValue: { logUsage: jest.fn().mockResolvedValue({}) },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: AiRelayService,
          useValue: { getStatus: jest.fn(), enqueuePrompt: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AiService);
  });

  afterAll(() => {
    if (originalAllowlist === undefined) {
      delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    } else {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = originalAllowlist;
    }
  });

  describe("a user who is not an admin", () => {
    it("cannot save a self-hosted provider at a private address", async () => {
      const attempt = service.createConfig(userId, {
        provider: "ollama",
        baseUrl: PRIVATE_URL,
      });
      await expect(attempt).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      await expect(attempt).rejects.toThrow(/private or local network/);
      expect(configRepo.save).not.toHaveBeenCalled();
    });

    it("cannot save an Ollama provider with no base URL, which is loopback", async () => {
      await expect(
        service.createConfig(userId, { provider: "ollama" }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(configRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      "http://127.0.0.1:11434",
      "http://[::1]:11434",
      "http://169.254.169.254/latest",
      "http://2130706433:11434",
    ])("cannot save an openai-compatible provider at %s", async (baseUrl) => {
      await expect(
        service.createConfig(userId, {
          provider: "openai-compatible",
          baseUrl,
        }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
    });

    it("cannot move a provider to a private address", async () => {
      configRepo.findOne.mockResolvedValue(
        storedConfig({ baseUrl: PUBLIC_URL }),
      );
      await expect(
        service.updateConfig(userId, "config-1", {
          baseUrl: "http://10.0.0.5:11434",
        }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(configRepo.save).not.toHaveBeenCalled();
    });

    it("cannot test a draft against a private address", async () => {
      await expect(
        service.testDraftConnection(userId, {
          provider: "openai-compatible",
          baseUrl: "http://10.0.0.5:8000/v1?x=",
          model: "m",
        }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(createProvider).not.toHaveBeenCalled();
    });

    it("can use a public address, restricted to public hosts on the connection", async () => {
      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: PUBLIC_URL,
      });
      expect(configRepo.save).toHaveBeenCalled();

      await service.testDraftConnection(userId, {
        provider: "ollama",
        baseUrl: PUBLIC_URL,
        model: "llama3",
      });
      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: PUBLIC_URL }),
        "public-or-allowlisted",
      );
    });

    it("can use an address the operator allowlisted", async () => {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "192.168.1.100:11434";
      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: PRIVATE_URL,
      });
      expect(configRepo.save).toHaveBeenCalled();

      await service.testDraftConnection(userId, {
        provider: "ollama",
        baseUrl: PRIVATE_URL,
        model: "llama3",
      });
      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: PRIVATE_URL }),
        "public-or-allowlisted",
      );
    });

    it("cannot use another port on an allowlisted host", async () => {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "192.168.1.100:11434";
      await expect(
        service.createConfig(userId, {
          provider: "ollama",
          baseUrl: "http://192.168.1.100:6379",
        }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
    });
  });

  describe("a stored private base URL of a user who is not an admin", () => {
    beforeEach(() => {
      configRepo.findOne.mockResolvedValue(storedConfig());
      configRepo.find.mockResolvedValue([storedConfig()]);
    });

    it("fails the connection test with the translated reason, without connecting", async () => {
      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/private or local network/);
      expect(createProvider).not.toHaveBeenCalled();
    });

    it("is refused for a completion, with the reason rather than the generic failure", async () => {
      await expect(
        service.complete(
          userId,
          { systemPrompt: "s", messages: [{ role: "user", content: "hi" }] },
          "insight",
        ),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(createProvider).not.toHaveBeenCalled();
    });

    it("is refused for a web-search completion", async () => {
      await expect(
        service.completeWithWebSearch(
          userId,
          { systemPrompt: "s", messages: [{ role: "user", content: "hi" }] },
          { maxUses: 1 },
          "payee-lookup",
        ),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(createProvider).not.toHaveBeenCalled();
    });

    it("is refused for the assistant's tool-use provider", async () => {
      await expect(
        service.resolveToolUseProvider(userId),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
      expect(createProvider).not.toHaveBeenCalled();
    });

    it("falls through to the next provider when there is one", async () => {
      const cloud = storedConfig({
        id: "config-2",
        provider: "anthropic",
        baseUrl: null,
        priority: 1,
      });
      configRepo.find.mockResolvedValue([storedConfig(), cloud]);
      const resolved = await service.resolveToolUseProvider(userId);
      expect(resolved.config).toBe(cloud);
      expect(createProvider).toHaveBeenCalledTimes(1);
      expect(createProvider).toHaveBeenCalledWith(cloud, "public-only");
    });
  });

  describe("an admin", () => {
    beforeEach(() => ownerRole("admin"));

    it("can save and use a self-hosted provider at a private address", async () => {
      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: PRIVATE_URL,
      });
      expect(configRepo.save).toHaveBeenCalled();

      configRepo.findOne.mockResolvedValue(storedConfig());
      await service.testConnection(userId, "config-1");
      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: PRIVATE_URL }),
        "any",
      );
    });

    it("is still held to a public host for a cloud provider", async () => {
      await expect(
        service.createConfig(userId, {
          provider: "openai",
          apiKey: "sk",
          baseUrl: "http://10.0.0.5/v1",
        }),
      ).rejects.toBeInstanceOf(AiBaseUrlRefusedError);
    });
  });

  it("leaves the operator's AI_DEFAULT_* provider unrestricted", async () => {
    configGet.mockImplementation((key: string) => {
      if (key === "AI_DEFAULT_PROVIDER") return "ollama";
      if (key === "AI_DEFAULT_BASE_URL") return "http://localhost:11434";
      return undefined;
    });
    configRepo.find.mockResolvedValue([]);

    await service.resolveToolUseProvider(userId);
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ isSystemDefault: true }),
      "any",
    );
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });
});
