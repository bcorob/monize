import { ConfigService } from "@nestjs/config";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../../../provider-health/provider-unavailable.error";
import {
  GOOGLE_PLACES_PROVIDER,
  GooglePlacesClient,
  GooglePlacesRejectedError,
} from "./google-places.client";

/**
 * The client is the one place this deployment talks to Google, so the tests
 * are about two things a mock of `fetch` can genuinely prove: the request we
 * send (URL, headers, field mask, body), and the breaker bookkeeping every
 * outcome owes -- which is where the subtle failures live, because a probe
 * slot held after an answered request takes the provider down for two minutes
 * with nothing wrong with it.
 */
describe("GooglePlacesClient", () => {
  const originalFetch = global.fetch;
  let health: jest.Mocked<
    Pick<
      ProviderHealthService,
      | "assertAvailable"
      | "recordSuccess"
      | "recordFailure"
      | "releaseProbe"
      | "logFailure"
    >
  >;
  let client: GooglePlacesClient;

  let env: Record<string, string | undefined>;

  const okResponse = (payload: unknown) => ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(payload),
  });

  beforeEach(() => {
    global.fetch = jest.fn();
    health = {
      assertAvailable: jest.fn().mockReturnValue("open-gate"),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn().mockReturnValue(true),
      releaseProbe: jest.fn(),
      logFailure: jest.fn(),
    } as unknown as typeof health;
    env = {};
    client = new GooglePlacesClient(
      health as unknown as ProviderHealthService,
      { get: (k: string) => env[k] } as unknown as ConfigService,
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const search = () =>
    client.searchText({
      apiKey: "key-1",
      textQuery: "Starbucks 483 Bay St",
      languageCode: "en-CA",
      regionCode: "CA",
      maxResults: 3,
    });

  /**
   * A key is a secret. `fetch` refuses a header value holding a control
   * character and QUOTES THE VALUE in the `TypeError` it throws -- so before
   * this guard, a key with one in it travelled into the application log
   * (through `logFailure`) and into the Test button's error text. The key is
   * encrypted at rest and never returned to the client for exactly that
   * reason.
   *
   * `global.fetch` is mocked in this file, so the first test uses the REAL
   * platform to establish the hazard: a mock cannot demonstrate a property of
   * header construction, and without it the rest of this block would be
   * asserting against a danger nobody has shown exists.
   */
  describe("a key that cannot be sent as a header", () => {
    const SECRET = "AIza-line-one\nline-two";

    it("really does leak through the platform's own error", () => {
      expect(() => new Headers({ "X-Goog-Api-Key": SECRET })).toThrow(
        expect.objectContaining({ message: expect.stringContaining(SECRET) }),
      );
    });

    it("is refused without naming the key, and without calling fetch", async () => {
      await expect(
        client.searchText({
          apiKey: SECRET,
          textQuery: "Starbucks",
          maxResults: 3,
        }),
      ).rejects.toMatchObject({
        name: "GooglePlacesRejectedError",
        status: 400,
      });

      const error = await client
        .searchText({ apiKey: SECRET, textQuery: "Starbucks", maxResults: 3 })
        .catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain("line-one");
      expect(String((error as Error).message)).not.toContain("line-two");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("spends no breaker bookkeeping on a request it never made", () => {
      // Not an outcome for Google: nothing was asked of it. Taking a probe
      // slot here would hold the provider down for a key only this user has.
      return client
        .searchText({ apiKey: SECRET, textQuery: "Starbucks", maxResults: 3 })
        .catch(() => {
          expect(health.assertAvailable).not.toHaveBeenCalled();
          expect(health.recordFailure).not.toHaveBeenCalled();
          expect(health.recordSuccess).not.toHaveBeenCalled();
          expect(health.logFailure).not.toHaveBeenCalled();
        });
    });

    it("sends an ordinary key through untouched", async () => {
      // The guard rejects control characters and nothing else: a key with a
      // space, or a non-ASCII character, is one the platform accepts.
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await client.searchText({
        apiKey: "AIza key-with-space-and-\u00e9",
        textQuery: "Starbucks",
        maxResults: 3,
      });

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("the request", () => {
    it("posts the text query with the key and the field mask", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await search();

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
      expect(init.method).toBe("POST");
      expect(init.headers["X-Goog-Api-Key"]).toBe("key-1");
      expect(JSON.parse(init.body)).toEqual({
        textQuery: "Starbucks 483 Bay St",
        pageSize: 3,
        languageCode: "en-CA",
        regionCode: "CA",
      });
    });

    it("asks for exactly the four fields the lookup can use", async () => {
      // The mask decides the billing SKU, so an extra field is a real cost.
      // nationalPhoneNumber is absent deliberately: a number with no country
      // code is dropped by the coordinator's normalization every time.
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await search();

      const mask = (global.fetch as jest.Mock).mock.calls[0][1].headers[
        "X-Goog-FieldMask"
      ];
      expect(mask.split(",").sort()).toEqual([
        "places.displayName",
        "places.formattedAddress",
        "places.internationalPhoneNumber",
        "places.websiteUri",
      ]);
      // Qualified, because "internationalPhoneNumber" contains the shorter
      // field's name as a substring and a bare match would always pass.
      expect(mask.split(",")).not.toContain("places.nationalPhoneNumber");
    });

    it("bounds the request with a timeout signal", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await search();

      expect(
        (global.fetch as jest.Mock).mock.calls[0][1].signal,
      ).toBeInstanceOf(AbortSignal);
    });

    it("omits the locale fields entirely when the user has no language stored", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await client.searchText({
        apiKey: "key-1",
        textQuery: "Acme",
        maxResults: 3,
      });

      expect(
        JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body),
      ).toEqual({ textQuery: "Acme", pageSize: 3 });
    });
  });

  describe("the answer", () => {
    it("reads displayName out of its text wrapper", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse({
          places: [
            {
              displayName: { text: "Starbucks", languageCode: "en" },
              formattedAddress: "483 Bay St, Toronto",
              internationalPhoneNumber: "+1 416-555-0100",
              websiteUri: "https://starbucks.ca",
            },
          ],
        }),
      );

      await expect(search()).resolves.toEqual([
        {
          displayName: "Starbucks",
          formattedAddress: "483 Bay St, Toronto",
          internationalPhoneNumber: "+1 416-555-0100",
          websiteUri: "https://starbucks.ca",
        },
      ]);
    });

    it("reads a place missing every optional field as nulls", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse({ places: [{}] }),
      );

      await expect(search()).resolves.toEqual([
        {
          displayName: null,
          formattedAddress: null,
          internationalPhoneNumber: null,
          websiteUri: null,
        },
      ]);
    });

    it("reads a response with no places key as no matches", async () => {
      // Google omits the key rather than sending an empty array.
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({}));

      await expect(search()).resolves.toEqual([]);
    });

    it("refuses a response shape it does not understand", async () => {
      // Reading this as "nothing found" would report a broken integration as an
      // answer, and `none` is the reason that retires the automatic lookup.
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse({ places: "nope" }),
      );

      await expect(search()).rejects.toThrow("unreadable response");
    });
  });

  describe("breaker bookkeeping", () => {
    it("takes the slot before the request is made", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await search();

      expect(health.assertAvailable).toHaveBeenCalledWith(
        GOOGLE_PLACES_PROVIDER,
      );
    });

    it("makes no request at all when the breaker is open", async () => {
      health.assertAvailable.mockImplementation(() => {
        throw new ProviderUnavailableError("Google Places", 1000, "down");
      });

      await expect(search()).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("records a rejected key as a SUCCESS, because the host answered", async () => {
      // One user's bad key must never open a deployment-wide breaker, nor page
      // the operator: Google plainly responded.
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 403,
        json: jest
          .fn()
          .mockResolvedValue({ error: { message: "API key not valid" } }),
      });

      await expect(search()).rejects.toBeInstanceOf(GooglePlacesRejectedError);
      expect(health.recordSuccess).toHaveBeenCalledWith(GOOGLE_PLACES_PROVIDER);
      expect(health.recordFailure).not.toHaveBeenCalled();
    });

    it("carries Google's own message on a refusal", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
          error: { message: "This API project is not authorized" },
        }),
      });

      await expect(search()).rejects.toThrow(
        "Google Places returned HTTP 400: This API project is not authorized",
      );
    });

    it("still reports a refusal whose body cannot be read", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 429,
        json: jest.fn().mockRejectedValue(new Error("no body")),
      });

      await expect(search()).rejects.toThrow("Google Places returned HTTP 429");
    });

    it("counts and logs a transport failure", async () => {
      const error = new TypeError("fetch failed");
      (global.fetch as jest.Mock).mockRejectedValue(error);

      await expect(search()).rejects.toBe(error);
      expect(health.recordFailure).toHaveBeenCalledWith(
        GOOGLE_PLACES_PROVIDER,
        error,
      );
      expect(health.logFailure).toHaveBeenCalled();
      expect(health.recordSuccess).not.toHaveBeenCalled();
    });

    it("counts a body that never finished arriving", async () => {
      // It happens after the headers, so it never reaches the fetch catch --
      // and with success already recorded there, a stalling host would never
      // open the breaker.
      const error = new Error("UND_ERR_BODY_TIMEOUT");
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(error),
      });

      await expect(search()).rejects.toBe(error);
      expect(health.recordFailure).toHaveBeenCalledWith(
        GOOGLE_PLACES_PROVIDER,
        error,
      );
      expect(health.recordSuccess).not.toHaveBeenCalled();
    });

    it("hands back a probe slot when the failure did not count", async () => {
      health.assertAvailable.mockReturnValue("probe");
      health.recordFailure.mockReturnValue(false);
      (global.fetch as jest.Mock).mockRejectedValue(new Error("bad url"));

      await expect(search()).rejects.toThrow("bad url");
      expect(health.releaseProbe).toHaveBeenCalledWith(GOOGLE_PLACES_PROVIDER);
    });

    it("does not hand back a slot it never held", async () => {
      // Releasing as a straggler admitted through a closed breaker would free
      // somebody else's probe and let a second one out beside it.
      health.assertAvailable.mockReturnValue("open-gate");
      health.recordFailure.mockReturnValue(false);
      (global.fetch as jest.Mock).mockRejectedValue(new Error("bad url"));

      await expect(search()).rejects.toThrow("bad url");
      expect(health.releaseProbe).not.toHaveBeenCalled();
    });
  });

  /**
   * Google's HTTP-referrer key restriction matches this header, and a server
   * sends none of its own -- which is why such a key answers "Requests from
   * referer <empty> are blocked" for every lookup. Browsers forbid script from
   * setting `Referer`; Node does not, so sending the deployment's own URL makes
   * that restriction satisfiable.
   *
   * It is worth saying what this does NOT buy, because the tests are the place
   * the intent survives: a referrer restriction protects a key that is public
   * (shipped in browser JS, where the browser sets the header). This key never
   * reaches a browser, so anything holding it can send this header too. The
   * restriction that actually constrains a server-side key is by IP.
   */
  describe("identifying the deployment to Google", () => {
    const headersOfLastCall = (): Record<string, string> =>
      (global.fetch as jest.Mock).mock.calls[0][1].headers;

    it("sends PUBLIC_APP_URL as the Referer", async () => {
      env.PUBLIC_APP_URL = "https://monize.laskonet.com";
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await client.searchText({
        apiKey: "k",
        textQuery: "Acme",
        maxResults: 3,
      });

      // Origin plus a trailing slash: Google matches patterns like
      // `*.laskonet.com/*`, and a path would only narrow what matches.
      expect(headersOfLastCall().Referer).toBe("https://monize.laskonet.com/");
    });

    it("reduces a URL carrying a path to its origin", async () => {
      env.PUBLIC_APP_URL = "https://monize.laskonet.com/app/?x=1";
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await client.searchText({
        apiKey: "k",
        textQuery: "Acme",
        maxResults: 3,
      });

      expect(headersOfLastCall().Referer).toBe("https://monize.laskonet.com/");
    });

    it("sends no Referer at all when PUBLIC_APP_URL is unset", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse({ places: [] }));

      await client.searchText({
        apiKey: "k",
        textQuery: "Acme",
        maxResults: 3,
      });

      // Omitted, not empty: an empty Referer is exactly what a restricted key
      // already rejects, so sending one would look like a value and match
      // nothing.
      expect(headersOfLastCall()).not.toHaveProperty("Referer");
      expect(client.referer()).toBeNull();
    });

    it("drops a value that is not an absolute http(s) URL", async () => {
      // A misconfigured PUBLIC_APP_URL must not become a header nothing can
      // match; the error message then correctly reports that none was sent.
      for (const bad of ["laskonet.com", "", "   ", "ftp://x.example"]) {
        env.PUBLIC_APP_URL = bad;
        expect(client.referer()).toBeNull();
      }
    });
  });
});
