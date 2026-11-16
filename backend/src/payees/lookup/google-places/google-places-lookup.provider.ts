import { Injectable } from "@nestjs/common";
import { sanitizeContactSuggestions } from "../contact-suggestion.sanitize";
import { hasLocationContext } from "../lookup-context";
import {
  ContactLookupUnavailableError,
  MAX_CONTACT_LOOKUP_MATCHES,
  PayeeContactLookupInput,
  PayeeContactSuggestion,
} from "../payee-contact-lookup.types";
import {
  GooglePlacesClient,
  GooglePlacesRejectedError,
  GooglePlacesResult,
} from "./google-places.client";

/**
 * The lookup adapter backed by Google Places.
 *
 * It answers the same question as the AI adapter from a business directory
 * rather than a language model, so its answers need no confidence judgement:
 * every field is a fact Google holds about a listed business, which is why
 * `confidence` is `null` and the sanitizer's per-source trust rules (which
 * withhold an address or phone from an unverified *model* answer) do not
 * apply to it -- `google-places` is not in `UNVERIFIED_CONTACT_LOOKUP_SOURCES`.
 *
 * It has no email. That is the whole reason the AI adapter stays: a directory
 * lookup cannot answer "what address do I write to", and a field Google does
 * not carry is left null rather than guessed at.
 *
 * Not injected with the user's identity or the database: the caller resolves
 * whose key is being spent and whether the quota allowed it, and hands the key
 * down. This class only turns one query into candidates.
 */
@Injectable()
export class GooglePlacesLookupProvider {
  constructor(private readonly client: GooglePlacesClient) {}

  /**
   * The candidates Google holds for this name, best first.
   *
   * Throws `ContactLookupUnavailableError("failed", detail)` when Google
   * refused -- a rejected key, a project without the API enabled, a quota
   * exhausted at Google's end -- because each of those is something the user
   * can act on and none of them is "nothing found". A transport failure and an
   * open breaker propagate as they are, for the coordinator to classify.
   */
  /**
   * What this deployment identifies itself as to Google, or null when it sends
   * nothing. Delegated rather than re-derived: the value in a Test button's
   * error message has to be the one the request actually carried, and two
   * readers of `PUBLIC_APP_URL` would eventually disagree about the trailing
   * slash or a stray path.
   */
  referer(): string | null {
    return this.client.referer();
  }

  async lookup(
    apiKey: string,
    input: PayeeContactLookupInput,
  ): Promise<PayeeContactSuggestion[]> {
    let places: GooglePlacesResult[];
    try {
      places = await this.client.searchText({
        apiKey,
        textQuery: this.buildQuery(input),
        languageCode: input.locale?.language,
        regionCode: input.locale?.region,
        maxResults: MAX_CONTACT_LOOKUP_MATCHES,
      });
    } catch (error) {
      if (error instanceof GooglePlacesRejectedError) {
        // The status travels with it: Google answered and refused, so the
        // request was never served and never billed.
        throw new ContactLookupUnavailableError(
          "failed",
          error.detail,
          error.status,
        );
      }
      throw error;
    }

    return sanitizeContactSuggestions(
      { matches: places.map((place) => this.toMatch(place, places.length)) },
      "google-places",
      input.known,
    );
  }

  /**
   * The name, plus whatever the user already holds that pins it to a place.
   *
   * A stored address is a constraint on WHICH branch the answer may come from,
   * not an answer to preserve (`lookup-context.ts`), and Text Search reads
   * exactly that: "Starbucks 483 Bay St Toronto" resolves the branch, while
   * "Starbucks" alone resolves whichever one Google ranks first. The address
   * is flattened to one line because the query is a single string.
   */
  private buildQuery(input: PayeeContactLookupInput): string {
    if (!hasLocationContext(input.known)) return input.name;
    const address = (input.known?.address ?? "").replace(/\s+/g, " ").trim();
    return address ? `${input.name} ${address}` : input.name;
  }

  /**
   * One place in the shape the shared sanitizer reads.
   *
   * The label exists to tell candidates apart in the picker, so it is supplied
   * only when there is more than one: `sanitizeContactSuggestions` drops an
   * alternate the user could not distinguish, and a label on a lone candidate
   * is noise the dialogue would render as a heading over nothing.
   */
  private toMatch(
    place: GooglePlacesResult,
    total: number,
  ): Record<string, unknown> {
    return {
      label: total > 1 ? this.buildLabel(place) : null,
      website: place.websiteUri,
      address: place.formattedAddress,
      // Google holds no email for a place.
      email: null,
      // E.164-ish, with its own country code -- which is what makes it
      // storable: a suggested number is normalized with no region, so a
      // national number would be dropped on arrival.
      phone: place.internationalPhoneNumber,
      // A directory hit is not a model's guess, so there is no confidence to
      // report and none is invented.
      confidence: null,
      notes: null,
    };
  }

  /** "Starbucks, 483 Bay St, Toronto" -- the name, then where it is. */
  private buildLabel(place: GooglePlacesResult): string | null {
    const parts = [place.displayName, place.formattedAddress].filter(
      (part): part is string => Boolean(part),
    );
    return parts.length > 0 ? parts.join(", ") : null;
  }
}
