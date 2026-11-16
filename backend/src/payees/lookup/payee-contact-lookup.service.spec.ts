import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { validateUrlIsSafe } from "../../ai/validators/safe-url.validator";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import {
  ContactLookupUnavailableError,
  PAYEE_CONTACT_LOOKUP_PROVIDER,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("../../ai/validators/safe-url.validator", () => ({
  validateUrlIsSafe: jest.fn().mockResolvedValue(true),
}));

const mockValidateUrlIsSafe = validateUrlIsSafe as jest.Mock;

describe("PayeeContactLookupService", () => {
  let service: PayeeContactLookupService;
  let provider: { lookup: jest.Mock };
  let preferenceRepo: Record<string, jest.Mock>;
  const userId = "user-1";

  const suggestion: PayeeContactSuggestion = {
    label: null,
    website: "https://acme.example",
    address: "1 Main St",
    email: "hi@acme.example",
    // Already in the stored form, so the vetting tests below can compare a
    // candidate verbatim; the normalization itself is exercised separately.
    phone: "+12064488762",
    source: "ai-web-search",
    confidence: "high",
    notes: null,
    refined: [],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockValidateUrlIsSafe.mockResolvedValue(true);
    provider = { lookup: jest.fn().mockResolvedValue([suggestion]) };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "en-CA",
        defaultCurrency: "CAD",
      }),
    };
    const scoped = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    const module = await Test.createTestingModule({
      providers: [
        PayeeContactLookupService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: PAYEE_CONTACT_LOOKUP_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = module.get(PayeeContactLookupService);
  });

  it("returns disabled without calling the provider when the preference is off", async () => {
    preferenceRepo.findOne.mockResolvedValue({
      userId,
      payeeContactLookupEnabled: false,
    });

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "disabled",
      suggestions: [],
    });
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it("treats a missing preferences row as disabled", async () => {
    preferenceRepo.findOne.mockResolvedValue(null);

    await expect(service.isEnabled(userId)).resolves.toBe(false);
    await expect(
      service.lookup(userId, { name: "Acme" }),
    ).resolves.toMatchObject({
      reason: "disabled",
    });
  });

  it("ignores the preference only when the caller says the click was the consent", async () => {
    preferenceRepo.findOne.mockResolvedValue({
      userId,
      payeeContactLookupEnabled: false,
    });

    await expect(
      service.lookup(userId, { name: "Acme" }, { ignorePreference: true }),
    ).resolves.toEqual({ reason: "ok", suggestions: [suggestion] });
  });

  it("passes the stored locale and currency as the hint when the caller gave none", async () => {
    await service.lookup(userId, { name: "Acme" });

    expect(provider.lookup).toHaveBeenCalledWith(userId, {
      name: "Acme",
      hint: "the user's locale is en-CA; their default currency is CAD",
      locale: { language: "en-CA", region: "CA" },
      known: undefined,
    });
  });

  it("keeps a caller-supplied hint", async () => {
    await service.lookup(userId, { name: "Acme", hint: "Springfield" });

    expect(provider.lookup).toHaveBeenCalledWith(userId, {
      name: "Acme",
      hint: "Springfield",
      locale: { language: "en-CA", region: "CA" },
      known: undefined,
    });
  });

  describe("the structured locale beside the prose hint", () => {
    // A model reads the sentence; Google Places takes codes. Both are derived
    // from the one stored language tag, so they cannot describe different users.
    it("carries no region for a language tag that names none", async () => {
      preferenceRepo.findOne.mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "en",
        defaultCurrency: "USD",
      });

      await service.lookup(userId, { name: "Acme" });

      expect(provider.lookup).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ locale: { language: "en" } }),
      );
    });

    it("upper-cases the region, because a CLDR region code is upper-case", async () => {
      preferenceRepo.findOne.mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "pt-br",
        defaultCurrency: "BRL",
      });

      await service.lookup(userId, { name: "Acme" });

      expect(provider.lookup).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          locale: { language: "pt-br", region: "BR" },
        }),
      );
    });

    it("passes no locale at all when the user has stored no language", async () => {
      preferenceRepo.findOne.mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: null,
        defaultCurrency: null,
      });

      await service.lookup(userId, { name: "Acme" });

      expect(provider.lookup).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ locale: undefined }),
      );
    });

    it("lets the caller override the derived locale", async () => {
      await service.lookup(userId, {
        name: "Acme",
        locale: { language: "fr-FR", region: "FR" },
      });

      expect(provider.lookup).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          locale: { language: "fr-FR", region: "FR" },
        }),
      );
    });
  });

  it("reports a spent quota as its own reason, not as no_provider", async () => {
    // The two send the user to opposite repairs -- wait out or raise the
    // Google Places cap, versus configure an AI provider they never wanted --
    // so the coordinator must not fold one into the other.
    provider.lookup.mockRejectedValue(
      new ContactLookupUnavailableError("quota_exceeded"),
    );

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "quota_exceeded",
      suggestions: [],
    });
  });

  it("hands the caller's known details to the adapter", async () => {
    await service.lookup(userId, {
      name: "Acme",
      known: { address: "Toronto", notes: "the Dundas branch" },
    });

    expect(provider.lookup).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        known: { address: "Toronto", notes: "the Dundas branch" },
      }),
    );
  });

  it("drops a refined website the URL check refused, and the refinement with it", async () => {
    mockValidateUrlIsSafe.mockResolvedValue(false);
    provider.lookup.mockResolvedValue([
      { ...suggestion, refined: ["website", "address"] },
    ]);

    await expect(
      service.lookup(userId, {
        name: "Acme",
        known: { website: "https://old.example", address: "Toronto" },
      }),
    ).resolves.toMatchObject({
      reason: "ok",
      suggestions: [
        expect.objectContaining({ website: null, refined: ["address"] }),
      ],
    });
  });

  it("returns none when the provider found nothing", async () => {
    provider.lookup.mockResolvedValue([]);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "none",
      suggestions: [],
    });
  });

  it("drops only the website when it does not pass the URL safety check", async () => {
    mockValidateUrlIsSafe.mockResolvedValue(false);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "ok",
      suggestions: [{ ...suggestion, website: null }],
    });
    expect(mockValidateUrlIsSafe).toHaveBeenCalledWith("https://acme.example");
  });

  it("returns none when dropping the website leaves nothing", async () => {
    mockValidateUrlIsSafe.mockResolvedValue(false);
    provider.lookup.mockResolvedValue([
      { ...suggestion, address: null, email: null, phone: null },
    ]);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "none",
      suggestions: [],
    });
  });

  it("keeps every candidate the adapter offered, best first", async () => {
    const second = {
      ...suggestion,
      label: "Acme, Springfield",
      address: "9 Elm St",
    };
    provider.lookup.mockResolvedValue([suggestion, second]);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "ok",
      suggestions: [suggestion, second],
    });
  });

  it("drops a candidate that fails the URL check outright, keeping the rest", async () => {
    // The alternate's only detail is a website, and it is the one refused.
    mockValidateUrlIsSafe.mockImplementation((url: string) =>
      Promise.resolve(url === "https://acme.example"),
    );
    provider.lookup.mockResolvedValue([
      suggestion,
      {
        ...suggestion,
        label: "Acme, Springfield",
        website: "http://127.0.0.1",
        address: null,
        email: null,
        phone: null,
      },
    ]);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "ok",
      suggestions: [suggestion],
    });
  });

  it("maps the adapter's no_provider to its own outcome without logging", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    provider.lookup.mockRejectedValue(
      new ContactLookupUnavailableError("no_provider"),
    );

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "no_provider",
      suggestions: [],
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("carries the adapter's actionable failure detail", async () => {
    provider.lookup.mockRejectedValue(
      new ContactLookupUnavailableError(
        "failed",
        "Your MCP relay agent is not connected.",
      ),
    );

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "failed",
      suggestions: [],
      detail: "Your MCP relay agent is not connected.",
    });
  });

  it("never rejects: an unexpected error becomes failed, logged once", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    provider.lookup.mockRejectedValue(new TypeError("fetch failed"));

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "failed",
      suggestions: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("fetch failed");
    warn.mockRestore();
  });

  describe("phone normalization", () => {
    it("stores a suggested number in the canonical form", async () => {
      // A model writes a number in whatever shape the page it read used, and
      // the background enrichment writes the answer straight into the column
      // without a DTO in the way -- so this is where it becomes storable. The
      // country code has to be the model's own (see below); the SHAPE around it
      // is still whatever the page used.
      provider.lookup.mockResolvedValue([
        { ...suggestion, phone: "+1 (206) 448-8762" },
      ]);

      const outcome = await service.lookup(userId, { name: "Acme" });

      expect(outcome.suggestions[0]?.phone).toBe("+12064488762");
    });

    it("keeps a suggestion that carries its own country code", async () => {
      provider.lookup.mockResolvedValue([
        { ...suggestion, phone: "+52 55 1234 5678" },
      ]);

      const outcome = await service.lookup(userId, { name: "Acme" });

      expect(outcome.suggestions[0]?.phone).toBe("+525512345678");
    });

    it("does not file a suggested number in the reader's own region", async () => {
      // The reader dials from the US; the payee is in Mexico City. Read as US,
      // "55 1234 5678" is a valid +15512345678 in New Jersey -- a DIFFERENT
      // number that dials, written into the column by the background
      // enrichment with nobody in the loop. The reader's region says where
      // they dial from, not where a third party's office is.
      preferenceRepo.findOne.mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "en",
        numberFormat: "en-US",
        defaultCurrency: "USD",
      });
      provider.lookup.mockResolvedValue([
        { ...suggestion, phone: "55 1234 5678", refined: ["phone"] },
      ]);

      const outcome = await service.lookup(userId, { name: "Acme" });

      expect(outcome.suggestions[0]?.phone).toBeNull();
      // A refinement the user can never be offered is not one.
      expect(outcome.suggestions[0]?.refined).toEqual([]);
    });

    it("drops a bare number even where the region would have placed it", async () => {
      // The GB reader and a GB number agree here -- and that coincidence is
      // exactly what must not be relied on, because nothing in the suggestion
      // says which country it came from. Same rule, whether or not the guess
      // would have been right.
      preferenceRepo.findOne.mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "en",
        numberFormat: "en-GB",
        defaultCurrency: "GBP",
      });
      provider.lookup.mockResolvedValue([
        { ...suggestion, phone: "020 7946 0958" },
      ]);

      const outcome = await service.lookup(userId, { name: "Acme" });

      expect(outcome.suggestions[0]?.phone).toBeNull();
    });

    it("does not read the region preference at all", async () => {
      // The teeth on the rule above: a region that is never read cannot be
      // reintroduced by accident.
      provider.lookup.mockResolvedValue([
        { ...suggestion, phone: "+52 55 1234 5678" },
      ]);

      await service.lookup(userId, { name: "Acme" });

      const select = preferenceRepo.findOne.mock.calls[0]?.[0]?.select ?? {};
      expect(select).not.toHaveProperty("numberFormat");
    });

    it("drops a candidate whose phone was its only field", async () => {
      provider.lookup.mockResolvedValue([
        {
          ...suggestion,
          website: null,
          address: null,
          email: null,
          phone: "not a number",
        },
      ]);

      await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
        reason: "none",
        suggestions: [],
      });
    });
  });
});
