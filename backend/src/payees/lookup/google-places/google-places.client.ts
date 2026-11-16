import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";
import { isSendableApiKey } from "./google-places-key";

/** The id this client reports under. Must match `TRACKED_PROVIDERS`. */
export const GOOGLE_PLACES_PROVIDER = "google_places";

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

/** A slow directory lookup is worse than none: the user is waiting on it. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The `Referer` this deployment sends, from `PUBLIC_APP_URL`.
 *
 * Google's HTTP-referrer key restriction matches this header, and a server
 * sends no referrer of its own -- which is why a key restricted that way
 * answers "Requests from referer <empty> are blocked" for every lookup. Sending
 * the deployment's own URL makes such a key work.
 *
 * **What it is worth, stated plainly.** A referrer restriction protects a key
 * that is PUBLIC -- shipped inside browser JavaScript, where the browser sets
 * `Referer` and page script cannot forge it. This key is not public: it lives
 * encrypted in the database and never reaches a browser. Anything that can
 * reach Google can send this header too (Node sets it happily; only browsers
 * treat it as forbidden), so the restriction filters nobody who has the key.
 * An IP restriction is the one that actually constrains a server-side key.
 *
 * It is still sent, because a deployment without a stable egress address --
 * a home server on a dynamic IP, a cluster with variable egress -- cannot use
 * an IP restriction at all, and for them a forgeable filter beats no filter.
 * The choice is the operator's; this just stops it being impossible.
 *
 * Only an absolute http(s) URL is sent, reduced to its origin: Google matches
 * patterns like `*.example.com/*`, a path would only narrow what matches, and
 * a malformed value is dropped rather than sent as a header nothing can match.
 */
function refererFrom(rawUrl: string | undefined): string | null {
  if (!rawUrl?.trim()) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/**
 * The fields asked for, which is also the SKU this request is billed at.
 *
 * `websiteUri` and `internationalPhoneNumber` put every call in Google's Text
 * Search Enterprise SKU (1,000 free per month -- see `google-places-cap.ts`),
 * so the mask is exactly what the lookup can use and nothing more.
 *
 * `nationalPhoneNumber` is deliberately absent even though it costs no more.
 * A suggested number is normalized with NO region
 * (`PayeeContactLookupService.vetCandidate`), because the reader's region says
 * where THEY dial from and is not evidence about a third party's number -- so
 * a national number would be dropped on arrival every time. Asking for a field
 * whose only possible fate is to be discarded would make the request look
 * richer than it is.
 */
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.websiteUri",
].join(",");

/** One place, reduced to the fields the mask asked for. */
export interface GooglePlacesResult {
  displayName: string | null;
  formattedAddress: string | null;
  internationalPhoneNumber: string | null;
  websiteUri: string | null;
}

export interface GooglePlacesSearchRequest {
  apiKey: string;
  textQuery: string;
  /** BCP 47, e.g. `en-CA`. Google returns localized names and addresses for it. */
  languageCode?: string;
  /** CLDR region, e.g. `CA`. Biases which country a bare name resolves in. */
  regionCode?: string;
  maxResults: number;
}

/**
 * The request was refused, and it was certainly not billed.
 *
 * Usually that means Google answered with a refusal; it also covers a key this
 * client declines to send at all (`HEADER_UNSAFE`), which is the same fact one
 * step earlier. Both are this user's configuration problem, both must reach
 * them as text they can act on, and for both the breaker must NOT open --
 * either the host plainly answered, or nothing was asked of it. One user's bad
 * key would otherwise take Places down for every user on the deployment and
 * page the operator over it.
 *
 * The "not billed" half is what `PayeeLookupSettingsService.testKey` reads
 * (through `ContactLookupUnavailableError.httpStatus`) to hand the quota slot
 * back, so a caller must not raise this for anything that may have been
 * served.
 */
export class GooglePlacesRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "GooglePlacesRejectedError";
  }
}

/**
 * The Places Text Search call, and the only place this deployment talks to
 * Google Places.
 *
 * Availability goes through `ProviderHealthService` in the shape every
 * outbound client here uses, and the two asymmetries are the same ones
 * `YahooFinanceService` documents: a non-2xx is a complete answer and is
 * recorded the moment it arrives, while a 2xx is recorded only once its BODY
 * has arrived (headers from a host that then stalls are not a completed
 * request, and recording them closed the breaker on every probe). An error the
 * breaker does not count is not an outcome either, so a probe holder hands the
 * slot back rather than holding it against a provider nothing has shown to be
 * down. `provider-call.guard.spec.ts` holds this shape.
 */
@Injectable()
export class GooglePlacesClient {
  private readonly logger = new Logger(GooglePlacesClient.name);

  constructor(
    private readonly health: ProviderHealthService,
    private readonly configService?: ConfigService,
  ) {}

  /**
   * What this deployment identifies itself as to Google, or null when
   * `PUBLIC_APP_URL` is unset or unparseable. Read per request rather than
   * cached, so the value follows configuration without a restart -- it costs
   * one URL parse against a 10-second network call.
   */
  referer(): string | null {
    return refererFrom(this.configService?.get<string>("PUBLIC_APP_URL"));
  }

  /**
   * Best matches for one free-text query, best first.
   *
   * Throws `ProviderUnavailableError` when the breaker is open,
   * `GooglePlacesRejectedError` when Google refused, and the transport error
   * itself when the request never completed. An empty array means Google
   * answered and knew nothing, which is a different fact from all three.
   */
  async searchText(
    request: GooglePlacesSearchRequest,
  ): Promise<GooglePlacesResult[]> {
    // Before the breaker is even consulted: this request cannot be built, so
    // it is neither an outcome for the provider nor a probe worth holding. The
    // message names the problem and NEVER the key -- which is the whole reason
    // the check is here rather than left to `fetch`.
    if (!isSendableApiKey(request.apiKey)) {
      throw new GooglePlacesRejectedError(
        400,
        "The stored Google Places API key contains a character that cannot be " +
          "sent in a request header. Re-enter the key.",
      );
    }

    const admission = this.health.assertAvailable(GOOGLE_PLACES_PROVIDER);
    const context = `payee contact lookup for "${request.textQuery}"`;
    const referer = this.referer();

    let response: Response;
    try {
      response = await fetch(SEARCH_TEXT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": request.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
          // Omitted entirely when there is nothing to say, rather than sent
          // empty: an empty Referer is what a restricted key already rejects.
          ...(referer ? { Referer: referer } : {}),
        },
        body: JSON.stringify({
          textQuery: request.textQuery,
          pageSize: request.maxResults,
          ...(request.languageCode
            ? { languageCode: request.languageCode }
            : {}),
          ...(request.regionCode ? { regionCode: request.regionCode } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.reportFailure(admission, context, error);
      throw error;
    }

    if (!response.ok) {
      // A complete answer with nothing left to read: the provider is up.
      this.health.recordSuccess(GOOGLE_PLACES_PROVIDER);
      throw new GooglePlacesRejectedError(
        response.status,
        await this.describeRejection(response),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // A body that never finished arriving is a transport failure, and it
      // happens after the headers -- so it never reaches the catch above and
      // has to be counted here, or a stalling host never opens the breaker.
      this.reportFailure(admission, context, error);
      throw error;
    }
    this.health.recordSuccess(GOOGLE_PLACES_PROVIDER);

    return this.readPlaces(payload);
  }

  /**
   * Count and log one failed attempt, and give back the probe slot when the
   * breaker did not count it.
   *
   * Only the probe holder may hand the slot back: a straggler admitted through
   * a closed breaker owns nothing, and releasing then would free somebody
   * else's probe and let a second one out beside it.
   */
  private reportFailure(
    admission: "open-gate" | "probe",
    context: string,
    error: unknown,
  ): void {
    const counted = this.health.recordFailure(GOOGLE_PLACES_PROVIDER, error);
    if (!counted && admission === "probe") {
      this.health.releaseProbe(GOOGLE_PLACES_PROVIDER);
    }
    // The single door for the log line; recording is idempotent per error
    // object, so the count above is not doubled by it.
    this.health.logFailure(this.logger, GOOGLE_PLACES_PROVIDER, context, error);
  }

  /**
   * Google's own message where it sent one, because the useful half of a 400 is
   * "API key not valid" or "this API is not enabled for your project" -- a bare
   * status sends the user to check the wrong thing. Bounded, because it is
   * rendered in the UI.
   */
  private async describeRejection(response: Response): Promise<string> {
    let message = "";
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body?.error?.message === "string") {
        message = body.error.message.trim();
      }
    } catch {
      // A refusal with an unreadable body is still a refusal.
    }
    const suffix = message ? `: ${message}` : "";
    return `Google Places returned HTTP ${response.status}${suffix}`.slice(
      0,
      300,
    );
  }

  /**
   * `{ places: [...] }`, or `{}` when nothing matched -- Google omits the key
   * entirely rather than sending an empty array. Anything else is a shape this
   * build does not understand, and reading it as "no matches" would report a
   * broken integration as an answer, which is the one thing the lookup's
   * `none` outcome must never mean.
   */
  private readPlaces(payload: unknown): GooglePlacesResult[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Google Places returned an unreadable response");
    }
    const places = (payload as { places?: unknown }).places;
    if (places === undefined) return [];
    if (!Array.isArray(places)) {
      throw new Error("Google Places returned an unreadable response");
    }
    return places.map((place) => this.readPlace(place));
  }

  private readPlace(place: unknown): GooglePlacesResult {
    const record = (place && typeof place === "object" ? place : {}) as Record<
      string,
      unknown
    >;
    // displayName is `{ text, languageCode }`, not a string.
    const displayName = record.displayName as { text?: unknown } | undefined;
    return {
      displayName:
        typeof displayName?.text === "string" ? displayName.text : null,
      formattedAddress: this.text(record.formattedAddress),
      internationalPhoneNumber: this.text(record.internationalPhoneNumber),
      websiteUri: this.text(record.websiteUri),
    };
  }

  private text(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }
}
