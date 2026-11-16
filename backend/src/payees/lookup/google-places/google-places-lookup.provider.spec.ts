import { ContactLookupUnavailableError } from "../payee-contact-lookup.types";
import {
  GooglePlacesClient,
  GooglePlacesRejectedError,
  GooglePlacesResult,
} from "./google-places.client";
import { GooglePlacesLookupProvider } from "./google-places-lookup.provider";

const place = (over: Partial<GooglePlacesResult> = {}): GooglePlacesResult => ({
  displayName: "Starbucks",
  formattedAddress: "483 Bay St, Toronto, ON M5G 2C9, Canada",
  internationalPhoneNumber: "+1 416-555-0100",
  websiteUri: "https://www.starbucks.ca",
  ...over,
});

describe("GooglePlacesLookupProvider", () => {
  let client: { searchText: jest.Mock };
  let provider: GooglePlacesLookupProvider;

  beforeEach(() => {
    client = { searchText: jest.fn().mockResolvedValue([place()]) };
    provider = new GooglePlacesLookupProvider(
      client as unknown as GooglePlacesClient,
    );
  });

  describe("the query it asks", () => {
    it("searches the name alone when nothing pins it to a place", async () => {
      await provider.lookup("key", { name: "Starbucks" });

      expect(client.searchText).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "key", textQuery: "Starbucks" }),
      );
    });

    it("folds a known address into the query", async () => {
      // A stored address is a constraint on WHICH branch may answer, not a
      // value to preserve -- searching the name alone returns whichever
      // location Google ranks first.
      await provider.lookup("key", {
        name: "Starbucks",
        known: { address: "483 Bay St\nToronto" },
      });

      expect(client.searchText).toHaveBeenCalledWith(
        expect.objectContaining({
          textQuery: "Starbucks 483 Bay St Toronto",
        }),
      );
    });

    it("ignores context that names no location", async () => {
      await provider.lookup("key", {
        name: "Starbucks",
        known: { notes: "the one near the office" },
      });

      expect(client.searchText).toHaveBeenCalledWith(
        expect.objectContaining({ textQuery: "Starbucks" }),
      );
    });

    it("passes the locale codes through", async () => {
      await provider.lookup("key", {
        name: "Starbucks",
        locale: { language: "fr-CA", region: "CA" },
      });

      expect(client.searchText).toHaveBeenCalledWith(
        expect.objectContaining({ languageCode: "fr-CA", regionCode: "CA" }),
      );
    });

    it("never asks for more candidates than the picker can show", async () => {
      await provider.lookup("key", { name: "Starbucks" });

      expect(client.searchText).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 3 }),
      );
    });
  });

  describe("the suggestions it returns", () => {
    it("maps a place onto the shared suggestion shape", async () => {
      const [suggestion] = await provider.lookup("key", { name: "Starbucks" });

      expect(suggestion).toMatchObject({
        website: "https://www.starbucks.ca",
        address: "483 Bay St, Toronto, ON M5G 2C9, Canada",
        phone: "+1 416-555-0100",
        source: "google-places",
      });
    });

    it("reports no email, because Google holds none", async () => {
      const [suggestion] = await provider.lookup("key", { name: "Starbucks" });

      expect(suggestion.email).toBeNull();
    });

    it("invents no confidence for a directory fact", async () => {
      // Confidence is a model's self-assessment. A listed business is not one,
      // and a fabricated "high" would change how the sanitizer trusts it.
      const [suggestion] = await provider.lookup("key", { name: "Starbucks" });

      expect(suggestion.confidence).toBeNull();
    });

    it("keeps a directory address and phone, which an unverified model answer would lose", async () => {
      // google-places is not in UNVERIFIED_CONTACT_LOOKUP_SOURCES, so the
      // sanitizer's high-confidence-only rule for those two fields does not
      // apply to it -- with confidence null, a model source would drop both.
      const [suggestion] = await provider.lookup("key", { name: "Starbucks" });

      expect(suggestion.address).not.toBeNull();
      expect(suggestion.phone).not.toBeNull();
    });

    it("labels candidates only when there is a choice to make", async () => {
      const [only] = await provider.lookup("key", { name: "Starbucks" });
      expect(only.label).toBeNull();

      client.searchText.mockResolvedValue([
        place(),
        place({
          displayName: "Starbucks",
          formattedAddress: "1 Dundas St W, Toronto",
          websiteUri: "https://www.starbucks.ca/dundas",
        }),
      ]);

      const many = await provider.lookup("key", { name: "Starbucks" });
      expect(many).toHaveLength(2);
      expect(many[0].label).toBe(
        "Starbucks, 483 Bay St, Toronto, ON M5G 2C9, Canada",
      );
      expect(many[1].label).toBe("Starbucks, 1 Dundas St W, Toronto");
    });

    it("returns nothing when Google knew nothing", async () => {
      client.searchText.mockResolvedValue([]);

      await expect(provider.lookup("key", { name: "Nope" })).resolves.toEqual(
        [],
      );
    });

    it("drops a place carrying no usable contact detail at all", async () => {
      client.searchText.mockResolvedValue([
        place({
          websiteUri: null,
          formattedAddress: null,
          internationalPhoneNumber: null,
        }),
      ]);

      await expect(
        provider.lookup("key", { name: "Starbucks" }),
      ).resolves.toEqual([]);
    });
  });

  describe("failures", () => {
    it("turns Google's refusal into a failed outcome carrying its message", async () => {
      // "API key not valid" is the whole value of the message: a generic
      // failure sends the user to check the wrong thing.
      client.searchText.mockRejectedValue(
        new GooglePlacesRejectedError(403, "HTTP 403: API key not valid"),
      );

      await expect(
        provider.lookup("key", { name: "Starbucks" }),
      ).rejects.toMatchObject({
        name: "ContactLookupUnavailableError",
        reason: "failed",
        detail: "HTTP 403: API key not valid",
      });
    });

    it("lets a transport failure through for the coordinator to classify", async () => {
      const error = new TypeError("fetch failed");
      client.searchText.mockRejectedValue(error);

      await expect(provider.lookup("key", { name: "Starbucks" })).rejects.toBe(
        error,
      );
      await expect(
        provider.lookup("key", { name: "Starbucks" }),
      ).rejects.not.toBeInstanceOf(ContactLookupUnavailableError);
    });
  });
});
