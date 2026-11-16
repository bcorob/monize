import { ProviderHealthService } from "../../provider-health/provider-health.service";
import { AiPayeeContactLookupProvider } from "./ai-payee-contact-lookup.provider";
import { GooglePlacesLookupProvider } from "./google-places/google-places-lookup.provider";
import { PayeeLookupQuotaService } from "./google-places/payee-lookup-quota.service";
import { PayeeLookupSettingsService } from "./google-places/payee-lookup-settings.service";
import {
  ContactLookupUnavailableError,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";
import { RoutingPayeeContactLookupProvider } from "./routing-payee-contact-lookup.provider";

const suggestionFrom = (
  source: PayeeContactSuggestion["source"],
): PayeeContactSuggestion => ({
  label: null,
  website: "https://acme.example",
  address: null,
  email: null,
  phone: null,
  source,
  confidence: null,
  notes: null,
  refined: [],
});

const placesAnswer = [suggestionFrom("google-places")];
const aiAnswer = [suggestionFrom("ai-web-search")];

/**
 * The routing matrix. Every row here is a decision a user can feel: which
 * service they pay for one lookup, and what they are told when neither can
 * answer.
 */
describe("RoutingPayeeContactLookupProvider", () => {
  let settings: { resolveSource: jest.Mock; resolveRouting: jest.Mock };
  /**
   * The router asks `resolveRouting` (key + order in one read). These specs
   * drive the key through `resolveSource`, so the two are kept in step here
   * rather than in every case: a spec that set only one of them would be
   * testing a settings row that cannot exist.
   */
  const setSource = (
    source: unknown,
    preferredSource = "google-places",
    aiEnabled = true,
  ) => {
    settings.resolveSource.mockResolvedValue(source);
    settings.resolveRouting.mockResolvedValue({
      places: source,
      preferredSource,
      aiEnabled,
    });
  };
  let quota: { claim: jest.Mock };
  let places: { lookup: jest.Mock };
  let ai: { lookup: jest.Mock };
  let health: { wouldRefuse: jest.Mock };
  let router: RoutingPayeeContactLookupProvider;

  const userSource = {
    kind: "user" as const,
    apiKey: "key-1",
    userId: "user-1",
    capEnabled: true,
    cap: 1000,
  };
  const operatorSource = {
    kind: "operator" as const,
    apiKey: "operator-key",
    capEnabled: true,
    cap: 1000,
  };

  beforeEach(() => {
    settings = { resolveSource: jest.fn(), resolveRouting: jest.fn() };
    setSource(userSource);
    quota = { claim: jest.fn().mockResolvedValue(1) };
    places = { lookup: jest.fn().mockResolvedValue(placesAnswer) };
    ai = { lookup: jest.fn().mockResolvedValue(aiAnswer) };
    health = { wouldRefuse: jest.fn().mockReturnValue(false) };
    router = new RoutingPayeeContactLookupProvider(
      settings as unknown as PayeeLookupSettingsService,
      quota as unknown as PayeeLookupQuotaService,
      places as unknown as GooglePlacesLookupProvider,
      ai as unknown as AiPayeeContactLookupProvider,
      health as unknown as ProviderHealthService,
    );
  });

  const lookup = () => router.lookup("user-1", { name: "Acme" });

  describe("with no Google Places key configured", () => {
    beforeEach(() => setSource({ kind: "none" }));

    it("answers through AI, exactly as before this feature existed", async () => {
      await expect(lookup()).resolves.toEqual(aiAnswer);
      expect(places.lookup).not.toHaveBeenCalled();
    });

    it("claims no quota for a lookup Places did not serve", async () => {
      await lookup();

      expect(quota.claim).not.toHaveBeenCalled();
    });
  });

  describe("with a key configured", () => {
    it("answers through Places and never asks AI", async () => {
      // Places REPLACES the AI lookup: paying an LLM beside a directory the
      // user configured is the thing this feature exists to stop.
      await expect(lookup()).resolves.toEqual(placesAnswer);
      expect(places.lookup).toHaveBeenCalledWith("key-1", { name: "Acme" });
      expect(ai.lookup).not.toHaveBeenCalled();
    });

    it("claims a request against the user's own counter first", async () => {
      await lookup();

      expect(quota.claim).toHaveBeenCalledWith(userSource);
      expect(quota.claim.mock.invocationCallOrder[0]).toBeLessThan(
        places.lookup.mock.invocationCallOrder[0],
      );
    });

    it("claims against the deployment's counter for the operator's key", async () => {
      setSource(operatorSource);

      await lookup();

      expect(quota.claim).toHaveBeenCalledWith(operatorSource);
      expect(places.lookup).toHaveBeenCalledWith("operator-key", {
        name: "Acme",
      });
    });

    it("answers through AI when the user switched Places off", async () => {
      setSource({ kind: "none" });

      await expect(lookup()).resolves.toEqual(aiAnswer);
    });
  });

  describe("when the monthly cap is spent", () => {
    beforeEach(() => quota.claim.mockResolvedValue(null));

    it("falls back to AI", async () => {
      // The cap is the user's own budget decision; stopping outright would
      // turn their limit into a broken feature.
      await expect(lookup()).resolves.toEqual(aiAnswer);
      expect(places.lookup).not.toHaveBeenCalled();
    });

    it("reports the cap, not a missing provider, when there is no AI either", async () => {
      // Two different repairs: wait out or raise the cap, versus configure a
      // provider the user may never have wanted.
      ai.lookup.mockRejectedValue(
        new ContactLookupUnavailableError("no_provider"),
      );

      await expect(lookup()).rejects.toMatchObject({
        reason: "quota_exceeded",
      });
    });

    it("passes an AI failure through as itself", async () => {
      const failure = new ContactLookupUnavailableError("failed", "relay down");
      ai.lookup.mockRejectedValue(failure);

      await expect(lookup()).rejects.toBe(failure);
    });
  });

  describe("when Google Places is failing", () => {
    it("reports the failure instead of quietly paying for AI", async () => {
      // A rejected key or a dead host is something the user or operator must
      // fix; absorbing it into an AI bill means they never find out.
      health.wouldRefuse.mockReturnValue(true);

      await expect(lookup()).rejects.toMatchObject({ reason: "failed" });
      expect(ai.lookup).not.toHaveBeenCalled();
    });

    it("spends no quota on a request the breaker would refuse", async () => {
      health.wouldRefuse.mockReturnValue(true);

      await expect(lookup()).rejects.toThrow();
      expect(quota.claim).not.toHaveBeenCalled();
    });

    it("lets a refusal from Google through without trying AI", async () => {
      places.lookup.mockRejectedValue(
        new ContactLookupUnavailableError("failed", "API key not valid"),
      );

      await expect(lookup()).rejects.toMatchObject({
        reason: "failed",
        detail: "API key not valid",
      });
      expect(ai.lookup).not.toHaveBeenCalled();
    });
  });

  /**
   * The other order. Google holds no email address, so a user who mainly wants
   * one is right to put their model first -- and the fallback rule has to be
   * the mirror image of the default's, not a looser one.
   */
  describe("when the user asks for AI first", () => {
    beforeEach(() => setSource(userSource, "ai"));

    it("answers through AI and never spends a Places request", async () => {
      await router.lookup("u1", { name: "Acme" });

      expect(ai.lookup).toHaveBeenCalled();
      expect(places.lookup).not.toHaveBeenCalled();
      // The cap exists to ration a key this lookup never used.
      expect(quota.claim).not.toHaveBeenCalled();
    });

    it("falls through to Places when no AI provider is configured", async () => {
      ai.lookup.mockRejectedValue(
        new ContactLookupUnavailableError("no_provider"),
      );

      await router.lookup("u1", { name: "Acme" });

      // A configuration reason, so the second source answers -- the same rule
      // the default order applies to a spent cap.
      expect(places.lookup).toHaveBeenCalled();
      expect(quota.claim).toHaveBeenCalled();
    });

    it("reports an AI failure instead of quietly paying Google for it", async () => {
      // The asymmetry that matters: a rejected key or a provider outage is
      // something the user must see. Silently buying the answer elsewhere means
      // they never learn their AI provider is broken -- and it is the exact
      // rule the default order applies to a Places failure.
      ai.lookup.mockRejectedValue(
        new ContactLookupUnavailableError("failed", "Anthropic returned 401"),
      );

      await expect(router.lookup("u1", { name: "Acme" })).rejects.toMatchObject(
        { reason: "failed", detail: "Anthropic returned 401" },
      );
      expect(places.lookup).not.toHaveBeenCalled();
      expect(quota.claim).not.toHaveBeenCalled();
    });

    it("reports no provider when neither source can answer", async () => {
      setSource({ kind: "none" }, "ai");
      ai.lookup.mockRejectedValue(
        new ContactLookupUnavailableError("no_provider"),
      );

      await expect(router.lookup("u1", { name: "Acme" })).rejects.toMatchObject(
        { reason: "no_provider" },
      );
    });
  });

  /**
   * The AI source's own switch. Off means NOT REACHED -- not first, and not as
   * the fallback when the Places cap is spent. A switch that still let it
   * answer sometimes would defeat the one thing it is for: not paying for it.
   */
  describe("when the AI source is switched off", () => {
    it("never asks AI, even with Places first and a spent cap", async () => {
      setSource(userSource, "google-places", false);
      quota.claim.mockResolvedValue(null);

      await expect(router.lookup("u1", { name: "Acme" })).rejects.toMatchObject(
        {
          reason: "quota_exceeded",
        },
      );
      expect(ai.lookup).not.toHaveBeenCalled();
    });

    it("answers through Places even when AI is the preferred source", async () => {
      // The order is a preference; the switch is a refusal, and a refusal wins.
      setSource(userSource, "ai", false);

      await router.lookup("u1", { name: "Acme" });

      expect(places.lookup).toHaveBeenCalled();
      expect(ai.lookup).not.toHaveBeenCalled();
    });

    it("reports no provider when Places cannot answer either", async () => {
      setSource({ kind: "none" }, "google-places", false);

      await expect(router.lookup("u1", { name: "Acme" })).rejects.toMatchObject(
        {
          reason: "no_provider",
        },
      );
      expect(ai.lookup).not.toHaveBeenCalled();
    });
  });
});
