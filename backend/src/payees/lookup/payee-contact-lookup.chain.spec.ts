import { DataSource } from "typeorm";
import { ProviderHealthService } from "../../provider-health/provider-health.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiPayeeContactLookupProvider } from "./ai-payee-contact-lookup.provider";
import { GooglePlacesClient } from "./google-places/google-places.client";
import { GooglePlacesLookupProvider } from "./google-places/google-places-lookup.provider";
import { PayeeLookupQuotaService } from "./google-places/payee-lookup-quota.service";
import { PayeeLookupSettingsService } from "./google-places/payee-lookup-settings.service";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import { RoutingPayeeContactLookupProvider } from "./routing-payee-contact-lookup.provider";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("../../ai/validators/safe-url.validator", () => ({
  validateUrlIsSafe: jest.fn().mockResolvedValue(true),
}));

/**
 * One test that runs the whole production path for a Google Places lookup:
 * the bytes Google sends, through the client, the provider's mapping, the
 * router's source decision, and the coordinator's sanitizing and website
 * vetting -- ending at the `ContactLookupOutcome` a caller actually reads.
 *
 * Every layer here has its own spec, and each passes while the seam between
 * two of them is wrong: the per-layer specs hand each other hand-built
 * objects, so a field the client stops parsing, a mapping that drops one, or
 * a trust rule that blanks it downstream is invisible to all of them. The
 * address is the case that motivated this -- `sanitizeContactSuggestion`
 * withholds address and phone for any source in
 * `UNVERIFIED_CONTACT_LOOKUP_SOURCES`, and a Places answer carries no
 * confidence, so listing `google-places` there (or stamping a candidate with
 * an AI source) silently reduces a directory result to a website and an
 * email, with every other spec still green.
 *
 * The fixture is a real Places response shape, not a minimal one: field names
 * as Google spells them, `displayName` as the `{ text, languageCode }` object
 * rather than a string, and both phone forms present.
 */
describe("payee contact lookup, end to end over Google Places", () => {
  const originalFetch = global.fetch;

  const GOOGLE_RESPONSE = {
    places: [
      {
        displayName: { text: "Starbucks", languageCode: "en" },
        formattedAddress: "483 Bay St, Toronto, ON M5G 2C9, Canada",
        nationalPhoneNumber: "(416) 585-4600",
        internationalPhoneNumber: "+1 416-585-4600",
        websiteUri: "https://www.starbucks.ca/store-locator/store/1006318",
      },
    ],
  };

  let service: PayeeContactLookupService;
  let ai: jest.Mocked<Pick<AiPayeeContactLookupProvider, "lookup">>;
  let claim: jest.Mock;

  /**
   * Answer the way Google does: return only the fields the request's
   * `X-Goog-FieldMask` asked for.
   *
   * A double that returns the whole fixture however it is called cannot see a
   * field dropped from the mask -- the client stops asking for the address,
   * Google stops sending it, and a test holding a fixture that always carries
   * one still passes. Projecting through the mask is what makes the fixture a
   * claim about a response this deployment could actually receive.
   */
  const respondHonouringFieldMask = (_url: string, init: RequestInit) => {
    const mask = String(
      (init.headers as Record<string, string>)["X-Goog-FieldMask"] ?? "",
    )
      .split(",")
      .map((entry) => entry.trim().replace(/^places\./, ""));
    const places = GOOGLE_RESPONSE.places.map((place) =>
      Object.fromEntries(
        Object.entries(place).filter(([field]) => mask.includes(field)),
      ),
    );
    return Promise.resolve({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ places }),
    });
  };

  beforeEach(() => {
    global.fetch = jest.fn(respondHonouringFieldMask as never);

    const health = {
      assertAvailable: jest.fn().mockReturnValue("open-gate"),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn().mockReturnValue(true),
      releaseProbe: jest.fn(),
      logFailure: jest.fn(),
      wouldRefuse: jest.fn().mockReturnValue(false),
    } as unknown as ProviderHealthService;

    // The user has a Places key of their own and is under the cap.
    const settings = {
      resolveSource: jest.fn().mockResolvedValue({
        kind: "user",
        apiKey: "user-key",
        userId: "u1",
        capEnabled: true,
        cap: 1000,
      }),
      resolveRouting: jest.fn().mockResolvedValue({
        places: {
          kind: "user",
          apiKey: "user-key",
          userId: "u1",
          capEnabled: true,
          cap: 1000,
        },
        preferredSource: "google-places",
      }),
    } as unknown as PayeeLookupSettingsService;
    claim = jest.fn().mockResolvedValue(1);
    const quota = { claim } as unknown as PayeeLookupQuotaService;

    // Present so the router COULD reach it, and asserted never to be used:
    // an AI fallback firing on the happy path would spend a model call and
    // stamp the answer with the wrong source.
    ai = { lookup: jest.fn() };

    const router = new RoutingPayeeContactLookupProvider(
      settings,
      quota,
      new GooglePlacesLookupProvider(new GooglePlacesClient(health)),
      ai as unknown as AiPayeeContactLookupProvider,
      health,
    );

    const scoped = createScopedDbMocks([
      [
        UserPreference,
        {
          findOne: jest.fn().mockResolvedValue({
            userId: "u1",
            payeeContactLookupEnabled: true,
            language: "en-CA",
            defaultCurrency: "CAD",
          }),
        },
      ],
    ]);
    service = new PayeeContactLookupService(
      scoped.dataSource as unknown as DataSource,
      router,
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("delivers every field Google holds for a payee with nothing stored", async () => {
    const outcome = await service.lookup("u1", { name: "Starbucks" });

    if (outcome.reason !== "ok") {
      throw new Error(`expected ok, got ${outcome.reason}`);
    }
    const [suggestion] = outcome.suggestions;
    expect(suggestion).toEqual(
      expect.objectContaining({
        address: "483 Bay St, Toronto, ON M5G 2C9, Canada",
        website: "https://www.starbucks.ca/store-locator/store/1006318",
        // Google has no email for a business; the lookup says so rather than
        // reaching for the AI path to invent one.
        email: null,
        source: "google-places",
      }),
    );
    // The international form is the one that survives: it is unambiguous, and
    // `sanitizePhone` keeps the digits it is given.
    expect(suggestion.phone).toContain("416");
    expect(ai.lookup).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("offers the branch address as a refinement when the user typed only a city", async () => {
    const outcome = await service.lookup("u1", {
      name: "Starbucks",
      known: { address: "Toronto" },
    });

    if (outcome.reason !== "ok") {
      throw new Error(`expected ok, got ${outcome.reason}`);
    }
    const [suggestion] = outcome.suggestions;
    expect(suggestion.address).toBe("483 Bay St, Toronto, ON M5G 2C9, Canada");
    // Named as a refinement, so INV-PAYEE-001 keeps the background write off
    // it and the user confirms it instead.
    expect(suggestion.refined).toContain("address");
  });

  it("drops the address as an echo when the user already holds it", async () => {
    const outcome = await service.lookup("u1", {
      name: "Starbucks",
      known: { address: "483 Bay St, Toronto, ON M5G 2C9, Canada" },
    });

    if (outcome.reason !== "ok") {
      throw new Error(`expected ok, got ${outcome.reason}`);
    }
    const [suggestion] = outcome.suggestions;
    // The same fact restated is not something found, so it cannot be reported
    // as one; the candidate survives on the website and phone it did find.
    expect(suggestion.address).toBeNull();
    expect(suggestion.refined).not.toContain("address");
    expect(suggestion.website).not.toBeNull();
  });
});
