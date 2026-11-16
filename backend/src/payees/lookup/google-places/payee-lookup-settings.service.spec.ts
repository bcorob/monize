import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { EncryptionService } from "../../../common/encryption/encryption.service";
import { createScopedDbMocks } from "../../../test-helpers/scoped-db-testing";
import { PayeeLookupSettings } from "../entities/payee-lookup-settings.entity";
import { GooglePlacesLookupProvider } from "./google-places-lookup.provider";
import { GOOGLE_PLACES_CAP } from "./google-places-cap";
import { PayeeLookupQuotaService } from "./payee-lookup-quota.service";
import { PayeeLookupSettingsService } from "./payee-lookup-settings.service";
import { ContactLookupUnavailableError } from "../payee-contact-lookup.types";
import { AiProviderConfig } from "../../../ai/entities/ai-provider-config.entity";

jest.mock("../../../common/db/scoped-db", () =>
  jest
    .requireActual("../../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";

describe("PayeeLookupSettingsService", () => {
  let service: PayeeLookupSettingsService;
  let repo: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let quota: { claim: jest.Mock; usedThisMonth: jest.Mock; release: jest.Mock };
  let places: { lookup: jest.Mock; referer: jest.Mock };
  let aiConfigRepo: Record<string, jest.Mock>;
  let env: Record<string, unknown>;

  const build = () => {
    const scoped = createScopedDbMocks([
      [PayeeLookupSettings, repo],
      [AiProviderConfig, aiConfigRepo],
    ]);
    return new PayeeLookupSettingsService(
      scoped.dataSource as unknown as DataSource,
      encryption as unknown as EncryptionService,
      quota as unknown as PayeeLookupQuotaService,
      places as unknown as GooglePlacesLookupProvider,
      {
        get: <T>(key: string) => env[key] as T | undefined,
      } as unknown as ConfigService,
    );
  };

  const storedRow = (over: Partial<PayeeLookupSettings> = {}) =>
    ({
      userId: USER,
      apiKeyEnc: "cipher",
      googlePlacesEnabled: true,
      capEnabled: true,
      monthlyCap: 1000,
      ...over,
    }) as PayeeLookupSettings;

  beforeEach(() => {
    jest.clearAllMocks();
    env = {};
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn(async (row) => row),
    };
    aiConfigRepo = { findOne: jest.fn().mockResolvedValue(null) };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((value: string) => `enc(${value})`),
      decrypt: jest.fn((value: string) => `dec(${value})`),
      canDecrypt: jest.fn().mockReturnValue(true),
    };
    quota = {
      claim: jest.fn().mockResolvedValue(1),
      usedThisMonth: jest.fn().mockResolvedValue(0),
      release: jest.fn().mockResolvedValue(undefined),
    };
    places = {
      lookup: jest.fn().mockResolvedValue([]),
      referer: jest.fn().mockReturnValue(null),
    };
    service = build();
  });

  describe("resolveSource: whose key is spent", () => {
    it("answers none when neither the operator nor the user configured one", async () => {
      await expect(service.resolveSource(USER)).resolves.toEqual({
        kind: "none",
      });
    });

    it("uses the user's own key and cap", async () => {
      repo.findOne.mockResolvedValue(storedRow({ monthlyCap: 250 }));

      await expect(service.resolveSource(USER)).resolves.toEqual({
        kind: "user",
        apiKey: "dec(cipher)",
        userId: USER,
        capEnabled: true,
        cap: 250,
      });
    });

    it("lets the operator's key win over the user's", async () => {
      // It is the deployment's own resource and is already paid for; offering
      // both would invite the user to pay twice for one lookup.
      env.GOOGLE_PLACES_API_KEY = "operator-key";
      repo.findOne.mockResolvedValue(storedRow());

      await expect(service.resolveSource(USER)).resolves.toEqual({
        kind: "operator",
        apiKey: "operator-key",
        capEnabled: true,
        cap: GOOGLE_PLACES_CAP.default,
      });
    });

    it("answers none when the user switched Places off, even in operator mode", async () => {
      env.GOOGLE_PLACES_API_KEY = "operator-key";
      repo.findOne.mockResolvedValue(
        storedRow({ googlePlacesEnabled: false, apiKeyEnc: null }),
      );

      await expect(service.resolveSource(USER)).resolves.toEqual({
        kind: "none",
      });
    });

    it("treats a key it cannot decrypt as no key at all", async () => {
      // A key we cannot read is a key we cannot spend, so offering it would
      // buy a refusal from Google instead of an answer.
      repo.findOne.mockResolvedValue(storedRow());
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad ciphertext");
      });

      await expect(service.resolveSource(USER)).resolves.toEqual({
        kind: "none",
      });
    });

    it("falls back to the default for a stored cap outside the range", async () => {
      repo.findOne.mockResolvedValue(storedRow({ monthlyCap: 0 }));

      await expect(service.resolveSource(USER)).resolves.toMatchObject({
        cap: GOOGLE_PLACES_CAP.default,
      });
    });
  });

  describe("getSettings", () => {
    it("reports an unconfigured user with the documented defaults", async () => {
      await expect(service.getSettings(USER)).resolves.toMatchObject({
        mode: "none",
        configured: false,
        enabled: true,
        capEnabled: true,
        monthlyCap: GOOGLE_PLACES_CAP.default,
        apiKeyMasked: null,
        usedThisMonth: 0,
      });
    });

    it("masks a stored key and never returns it", async () => {
      repo.findOne.mockResolvedValue(storedRow());

      const view = await service.getSettings(USER);

      expect(view.apiKeyMasked).toBe("****");
      expect(JSON.stringify(view)).not.toContain("cipher");
      expect(JSON.stringify(view)).not.toContain("dec(cipher)");
    });

    it("reports an unreadable key distinctly from a missing one", async () => {
      // Different repairs: re-enter the key, versus enter one for the first
      // time. Folding them together sends the user to the wrong screen.
      repo.findOne.mockResolvedValue(storedRow());
      encryption.canDecrypt.mockReturnValue(false);

      await expect(service.getSettings(USER)).resolves.toMatchObject({
        apiKeyMasked: "****",
        apiKeyReadable: false,
      });
    });

    it("reports the operator's cap in operator mode", async () => {
      env.GOOGLE_PLACES_API_KEY = "operator-key";
      env.GOOGLE_PLACES_MONTHLY_CAP = "5000";

      await expect(service.getSettings(USER)).resolves.toMatchObject({
        mode: "operator",
        configured: true,
        monthlyCap: 5000,
      });
    });

    it("reports this month's usage against whichever key applies", async () => {
      repo.findOne.mockResolvedValue(storedRow());
      quota.usedThisMonth.mockResolvedValue(42);

      await expect(service.getSettings(USER)).resolves.toMatchObject({
        usedThisMonth: 42,
      });
    });

    it("says when the server cannot store a key at all", async () => {
      encryption.isConfigured.mockReturnValue(false);

      await expect(service.getSettings(USER)).resolves.toMatchObject({
        encryptionAvailable: false,
      });
    });
  });

  describe("updateSettings", () => {
    it("encrypts a new key before storing it", async () => {
      await service.updateSettings(USER, { apiKey: "secret" });

      expect(encryption.encrypt).toHaveBeenCalledWith("secret");
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyEnc: "enc(secret)" }),
      );
    });

    it("clears the stored key for an empty string", async () => {
      repo.findOne.mockResolvedValue(storedRow());

      await service.updateSettings(USER, { apiKey: "" });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyEnc: null }),
      );
    });

    it("keeps the stored key when the field is absent", async () => {
      // The card saves the switch without resending a secret it cannot read.
      repo.findOne.mockResolvedValue(storedRow());

      await service.updateSettings(USER, { enabled: false });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeyEnc: "cipher",
          googlePlacesEnabled: false,
        }),
      );
    });

    it("refuses to store a key with no ENCRYPTION_KEY on the server", async () => {
      encryption.isConfigured.mockReturnValue(false);

      await expect(
        service.updateSettings(USER, { apiKey: "secret" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it.each([
      ["a key", { apiKey: "secret" }],
      ["the cap switch", { capEnabled: false }],
      ["the cap", { monthlyCap: 10 }],
    ])(
      "refuses %s in operator mode rather than ignoring it",
      async (_l, patch) => {
        // A stored setting that can never apply looks, from the screen, exactly
        // like one that does.
        env.GOOGLE_PLACES_API_KEY = "operator-key";

        await expect(
          service.updateSettings(USER, patch),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repo.save).not.toHaveBeenCalled();
      },
    );

    it("still accepts the on/off switch in operator mode", async () => {
      env.GOOGLE_PLACES_API_KEY = "operator-key";

      await service.updateSettings(USER, { enabled: false });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ googlePlacesEnabled: false }),
      );
    });

    it("creates a first row on the documented defaults", async () => {
      await service.updateSettings(USER, { apiKey: "secret" });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          googlePlacesEnabled: true,
          capEnabled: true,
          monthlyCap: GOOGLE_PLACES_CAP.default,
        }),
      );
    });
  });

  describe("getStatus", () => {
    it("offers nothing when neither source can answer", async () => {
      await expect(service.getStatus(USER, false)).resolves.toMatchObject({
        available: false,
        source: null,
      });
    });

    it("names AI as the source when only AI is configured", async () => {
      await expect(service.getStatus(USER, true)).resolves.toMatchObject({
        available: true,
        source: "ai",
      });
    });

    it("names Places as the source when a key is configured", async () => {
      repo.findOne.mockResolvedValue(storedRow());

      await expect(service.getStatus(USER, true)).resolves.toMatchObject({
        source: "google-places",
        googlePlaces: { mode: "user", enabled: true, capReached: false },
      });
    });

    it("reports the cap as reached and hands the source back to AI", async () => {
      repo.findOne.mockResolvedValue(storedRow({ monthlyCap: 10 }));
      quota.usedThisMonth.mockResolvedValue(10);

      await expect(service.getStatus(USER, true)).resolves.toMatchObject({
        available: true,
        source: "ai",
        googlePlaces: { capReached: true },
      });
    });

    it("stays available with a spent cap and no AI, so the click can explain itself", async () => {
      // The lookup will refuse, but hiding the control would leave the user
      // with no way to find out why.
      repo.findOne.mockResolvedValue(storedRow({ monthlyCap: 10 }));
      quota.usedThisMonth.mockResolvedValue(10);

      await expect(service.getStatus(USER, false)).resolves.toMatchObject({
        available: false,
        source: null,
        googlePlaces: { capReached: true },
      });
    });

    it("never reports a cap as reached when the cap is switched off", async () => {
      repo.findOne.mockResolvedValue(storedRow({ capEnabled: false }));
      quota.usedThisMonth.mockResolvedValue(999_999);

      await expect(service.getStatus(USER, false)).resolves.toMatchObject({
        source: "google-places",
        googlePlaces: { capReached: false },
      });
    });
  });

  describe("testKey", () => {
    it("checks a draft key through the same provider a lookup uses", async () => {
      await expect(service.testKey(USER, "draft-key")).resolves.toEqual({
        available: true,
      });
      expect(places.lookup).toHaveBeenCalledWith(
        "draft-key",
        expect.objectContaining({ name: expect.any(String) }),
      );
    });

    it("counts the test against the quota, because Google bills it", async () => {
      repo.findOne.mockResolvedValue(storedRow());

      await service.testKey(USER);

      expect(quota.claim).toHaveBeenCalled();
    });

    it("reports Google's own refusal message", async () => {
      places.lookup.mockRejectedValue(new Error("HTTP 403: API key not valid"));

      await expect(service.testKey(USER, "draft-key")).resolves.toEqual({
        available: false,
        error: "HTTP 403: API key not valid",
      });
    });

    it("hands the slot back when Google refused, because it billed nothing", async () => {
      // A refusal was answered but never served. Charging for it means every
      // check of a broken key costs a request, and a key rejected on every
      // attempt would spend the month failing.
      places.lookup.mockRejectedValue(
        new ContactLookupUnavailableError(
          "failed",
          "Google Places returned HTTP 400: API key not valid",
          400,
        ),
      );

      await service.testKey(USER, "draft-key");

      expect(quota.release).toHaveBeenCalled();
    });

    it("keeps the slot when nobody answered", async () => {
      // A timeout or a dropped connection: Google may have served and billed
      // the request while we failed to hear it. Under-counting is the
      // direction that costs money, so an unknown outcome keeps the slot.
      places.lookup.mockRejectedValue(new Error("fetch failed"));

      await service.testKey(USER, "draft-key");

      expect(quota.release).not.toHaveBeenCalled();
    });

    describe("a referrer rejection", () => {
      beforeEach(() => {
        places.lookup.mockRejectedValue(
          new ContactLookupUnavailableError(
            "failed",
            "Google Places returned HTTP 403: Requests from referer <empty> are blocked.",
            403,
          ),
        );
      });

      it("names the exact referrer this deployment sends", async () => {
        // The whole fix is usually one string: a restriction written
        // *.laskonet.com/* does not match a bare laskonet.com, and the user
        // cannot compare against a value nothing tells them.
        places.referer.mockReturnValue("https://monize.laskonet.com/");

        const result = await service.testKey(USER, "draft-key");

        expect(result.available).toBe(false);
        expect(result.error).toContain("https://monize.laskonet.com/");
        // Google's own "<empty>" is now wrong as well as unhelpful: a referrer
        // IS being sent, it just is not on the allow-list.
        expect(result.error).not.toMatch(/<empty>/);
      });

      it("says no referrer is sent when PUBLIC_APP_URL is unset", async () => {
        // Here "<empty>" is literally true, and the repair is different: set
        // PUBLIC_APP_URL, or restrict by IP. Reporting the first message would
        // send the user to add a value to an allow-list that would still never
        // match.
        places.referer.mockReturnValue(null);

        const result = await service.testKey(USER, "draft-key");

        expect(result.error).toMatch(/PUBLIC_APP_URL/);
        expect(result.error).toMatch(/IP address/i);
      });
    });

    it("refuses when no key is configured and none was supplied", async () => {
      await expect(service.testKey(USER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("reports a spent cap instead of making the request", async () => {
      repo.findOne.mockResolvedValue(storedRow());
      quota.claim.mockResolvedValue(null);

      const result = await service.testKey(USER);

      expect(result.available).toBe(false);
      expect(places.lookup).not.toHaveBeenCalled();
    });

    it("refuses a draft key in operator mode", async () => {
      env.GOOGLE_PLACES_API_KEY = "operator-key";

      await expect(service.testKey(USER, "draft-key")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("refuses a test of the operator's own key, and spends nothing", async () => {
      // The key is the deployment's and the counter is shared, so a user
      // testing it spends a slot every other user was going to use. At the
      // throttle ceiling one caller drains the month; the UI hiding the button
      // is not what stops them.
      env.GOOGLE_PLACES_API_KEY = "operator-key";

      await expect(service.testKey(USER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(quota.claim).not.toHaveBeenCalled();
      expect(places.lookup).not.toHaveBeenCalled();
    });
  });

  /**
   * The pin names a row the client chose, so it is a server-authoritative
   * value: a provider id belonging to somebody else must not become this
   * user's, and the check runs inside the transaction that stores it so a
   * rejection has written nothing.
   */
  describe("pinning an AI provider", () => {
    const CONFIG_ID = "33333333-3333-4333-8333-333333333333";

    it("stores an id that names one of the caller's own providers", async () => {
      aiConfigRepo.findOne.mockResolvedValue({ id: CONFIG_ID });

      await service.updateSettings(USER, { aiProviderConfigId: CONFIG_ID });

      expect(aiConfigRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CONFIG_ID, userId: USER } }),
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ aiProviderConfigId: CONFIG_ID }),
      );
    });

    it("refuses an id that is not the caller's, and writes nothing", async () => {
      // findOne is scoped by userId, so another user's provider answers null.
      aiConfigRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(USER, { aiProviderConfigId: CONFIG_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("clears the pin on null without consulting the provider table", async () => {
      // Null is "no preference", not an id to verify -- looking it up would
      // reject the one value that means "stop pinning".
      await service.updateSettings(USER, { aiProviderConfigId: null });

      expect(aiConfigRepo.findOne).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ aiProviderConfigId: null }),
      );
    });

    it("leaves an existing pin alone when the field is absent", async () => {
      // The card saves one control at a time; a patch about the cap must not
      // silently unpin the provider.
      repo.findOne.mockResolvedValue(
        storedRow({ aiProviderConfigId: CONFIG_ID }),
      );

      await service.updateSettings(USER, { monthlyCap: 500 });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ aiProviderConfigId: CONFIG_ID }),
      );
    });
  });
});
