import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { validateUrlIsSafe } from "../../ai/validators/safe-url.validator";
import { normalizePhoneNumber } from "../../common/phone-number.util";
import { UserPreference } from "../../users/entities/user-preference.entity";
import {
  ContactLookupOutcome,
  ContactLookupSuggestions,
  ContactLookupUnavailableError,
  PAYEE_CONTACT_LOOKUP_PROVIDER,
  PayeeContactLookupInput,
  PayeeContactLookupProvider,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

/**
 * The language tag split into the two codes a directory API takes.
 *
 * `en-CA` gives both; a bare `en` gives a language and NO region, which is
 * correct rather than unfortunate -- a region biases which country a bare name
 * resolves in, and guessing one from a language would file a "Boots" in the
 * wrong country as confidently as it files the right one.
 *
 * This is a search bias, not a phone-number region: the two are unrelated, and
 * a suggested number is still normalized with no region at all (`vetCandidate`).
 */
function localeCodes(
  language: string | null | undefined,
): { language?: string; region?: string } | undefined {
  if (!language) return undefined;
  const [base, region] = language.split("-");
  if (!base) return undefined;
  return region ? { language, region: region.toUpperCase() } : { language };
}

export interface ContactLookupOptions {
  /**
   * Skip the opt-in preference. Only for a lookup the user just asked for by
   * name -- the "Look up" buttons -- where the click is the consent. The
   * automatic paths (form prefill, background enrichment, AI/MCP preview)
   * never set it.
   */
  ignorePreference?: boolean;
}

interface LookupPreferences {
  enabled: boolean;
  hint: string | undefined;
  /**
   * The same facts as `hint`, in codes rather than prose. A model reads the
   * sentence; a directory API takes `languageCode`/`regionCode`.
   */
  locale: { language?: string; region?: string } | undefined;
}

/**
 * The one door to a contact lookup. Every caller gets a `ContactLookupOutcome`
 * and never an exception: a lookup is best-effort everywhere it runs, and a
 * failure has to be *named* rather than thrown, because the caller must tell
 * the user "could not look" and never "nothing found" for it.
 *
 * Gate, then adapter, then two checks on the answer: the sanitizer (shape and
 * per-source trust, `sanitizeContactSuggestion`) already ran in the adapter;
 * here the website is additionally resolved through `validateUrlIsSafe`,
 * which refuses private and loopback addresses (SSRF, since the favicon
 * fetcher will visit it) and, as a side effect, an invented hostname that
 * does not resolve, and the phone is normalized to the stored E.164 form.
 *
 * The phone belongs here rather than in the sanitizer because normalizing is
 * not a pure reshape -- it can REFUSE, and a refusal here is the point. This is
 * the single door for every lookup -- the detail page's button, the form's
 * prefill, the AI/MCP create preview and the background enrichment -- so
 * `ENRICHMENT_UPDATE_SQL`, which writes a suggestion straight into the column
 * without passing a DTO, can never store a number in some other shape.
 */
@Injectable()
export class PayeeContactLookupService {
  private readonly logger = new Logger(PayeeContactLookupService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYEE_CONTACT_LOOKUP_PROVIDER)
    private readonly provider: PayeeContactLookupProvider,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.readPreferences(userId)).enabled;
  }

  async lookup(
    userId: string,
    input: PayeeContactLookupInput,
    options: ContactLookupOptions = {},
  ): Promise<ContactLookupOutcome> {
    const preferences = await this.readPreferences(userId);
    if (!preferences.enabled && !options.ignorePreference) {
      return { reason: "disabled", suggestions: [] };
    }

    let candidates: PayeeContactSuggestion[];
    try {
      candidates = await this.provider.lookup(userId, {
        name: input.name,
        hint: input.hint ?? preferences.hint,
        locale: input.locale ?? preferences.locale,
        known: input.known,
      });
    } catch (error) {
      if (error instanceof ContactLookupUnavailableError) {
        // Three reasons, three repairs: configure a provider, wait out or raise
        // the Google Places cap, or fix whatever the detail names. Folding any
        // two of them together sends the user to the wrong one.
        if (error.reason === "no_provider") {
          return { reason: "no_provider", suggestions: [] };
        }
        if (error.reason === "quota_exceeded") {
          return { reason: "quota_exceeded", suggestions: [] };
        }
        return { reason: "failed", suggestions: [], detail: error.detail };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Contact lookup failed for payee "${input.name}": ${message}`,
      );
      return { reason: "failed", suggestions: [] };
    }

    const checked: PayeeContactSuggestion[] = [];
    for (const candidate of candidates) {
      const vetted = await this.vetCandidate(candidate);
      if (vetted) checked.push(vetted);
    }
    const [best, ...rest] = checked;
    if (!best) {
      return { reason: "none", suggestions: [] };
    }
    const suggestions: ContactLookupSuggestions = [best, ...rest];
    return { reason: "ok", suggestions };
  }

  /**
   * The per-field checks the pure sanitizer cannot make, because each of them
   * can REFUSE: a website resolved through `validateUrlIsSafe` (which turns
   * down private and loopback addresses and, as a side effect, an invented
   * hostname), and a phone read as a number rather than a string.
   *
   * A field that does not survive is dropped to null, together with any claim
   * that it refined a value the user holds -- a refinement the user can never
   * be offered is not one. A candidate left with nothing at all is not a
   * candidate.
   */
  private async vetCandidate(
    suggestion: PayeeContactSuggestion,
  ): Promise<PayeeContactSuggestion | null> {
    const website =
      suggestion.website && (await validateUrlIsSafe(suggestion.website))
        ? suggestion.website
        : null;
    // A model writes a number in whatever shape the page it read used, so this
    // is where a suggestion becomes storable -- with NO region, deliberately.
    //
    // The reader's region says where THEY dial from; it is not evidence about
    // a third party's number, and this path is the one that writes without
    // anyone to ask (the background enrichment's UPDATE). Read in the reader's
    // region, a Mexico City "55 1234 5678" is a perfectly valid +15512345678 in
    // New Jersey -- a different number that dials, stored under a name the user
    // trusts. So a suggestion has to carry its own country code, which is what
    // the prompt asks the model for; one that does not is unplaceable and is
    // dropped. An empty field the user can fill beats a confident wrong number.
    const normalized = suggestion.phone
      ? normalizePhoneNumber(suggestion.phone, null)
      : null;
    const phone = normalized?.ok ? normalized.stored : null;
    const dropped = new Set<string>();
    if (website === null) dropped.add("website");
    if (phone === null) dropped.add("phone");
    const checked: PayeeContactSuggestion = {
      ...suggestion,
      website,
      phone,
      refined:
        dropped.size > 0
          ? suggestion.refined.filter((field) => !dropped.has(field))
          : suggestion.refined,
    };
    const hasAny =
      checked.website !== null ||
      checked.address !== null ||
      checked.email !== null ||
      checked.phone !== null;
    return hasAny ? checked : null;
  }

  /**
   * The opt-in flag, plus the two facts about the user that disambiguate a
   * name ("Hydro One" vs "Hydro-Québec"): their language tag and default
   * currency. Both are already stored; nothing new is collected.
   *
   * Deliberately NOT the region their preferences imply: see `vetCandidate`.
   * A suggested number is placed by its own country code or not at all, so
   * there is nothing here for a region to decide.
   */
  private async readPreferences(userId: string): Promise<LookupPreferences> {
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
        select: {
          userId: true,
          payeeContactLookupEnabled: true,
          language: true,
          defaultCurrency: true,
        },
      }),
    );
    const parts: string[] = [];
    if (prefs?.language) parts.push(`the user's locale is ${prefs.language}`);
    if (prefs?.defaultCurrency) {
      parts.push(`their default currency is ${prefs.defaultCurrency}`);
    }
    return {
      enabled: prefs?.payeeContactLookupEnabled === true,
      hint: parts.length > 0 ? parts.join("; ") : undefined,
      locale: localeCodes(prefs?.language),
    };
  }
}
