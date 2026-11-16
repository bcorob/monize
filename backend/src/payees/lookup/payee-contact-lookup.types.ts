/**
 * Shared shapes for the payee contact lookup: the adapter a data source
 * implements, the suggestion it returns, and the outcome the coordinator hands
 * to every caller (form endpoint, background enrichment, AI/MCP preview).
 *
 * The lookup is pluggable, and there are two adapters: the user's configured
 * AI provider (`AiPayeeContactLookupProvider`) and Google Places
 * (`GooglePlacesLookupProvider`). Which one answers is decided per lookup by
 * `RoutingPayeeContactLookupProvider`, the only implementation bound to the
 * token -- see `payee-contact-lookup.module.ts`.
 */

import { PayeeLookupContext } from "./lookup-context";

/**
 * Where a looked-up value came from. Persisted in `payees.contact_lookup_source`
 * (the CHECK constraint in migration 173 lists the same values) and mirrored in
 * `frontend/src/types/payee.ts`.
 *
 * - `ai-web-search`: the AI provider ran a real web search and answered from it.
 * - `ai-knowledge`: the AI provider answered from model memory (no search
 *   available, or none ran). Lower trust -- see `sanitizeContactSuggestion`.
 * - `ai-relay`: the user's own agent behind the MCP relay answered. It cannot
 *   report whether it searched, so it is trusted like `ai-knowledge`.
 * - `google-places`: Google's business directory, via the Places adapter. A
 *   listed fact rather than a model's recollection, so it is not in
 *   `UNVERIFIED_CONTACT_LOOKUP_SOURCES` and carries no confidence.
 */
export const CONTACT_LOOKUP_SOURCES = [
  "ai-web-search",
  "ai-knowledge",
  "ai-relay",
  "google-places",
] as const;
export type ContactLookupSource = (typeof CONTACT_LOOKUP_SOURCES)[number];

/** Sources whose answers did not come from a verified web search. */
export const UNVERIFIED_CONTACT_LOOKUP_SOURCES: readonly ContactLookupSource[] =
  ["ai-knowledge", "ai-relay"];

export type ContactLookupConfidence = "high" | "medium" | "low";

export interface PayeeContactLookupInput {
  name: string;
  /** Optional disambiguation, e.g. the user's country. Never persisted. */
  hint?: string;
  /**
   * The user's locale, structured rather than prose.
   *
   * The AI adapter folds the same facts into `hint` because a model reads
   * sentences; a directory API takes codes, so Google Places sends
   * `languageCode` and `regionCode` and gets localized addresses and the right
   * country's branch of a chain. Both are derived from preferences the user
   * has already set -- nothing new is collected.
   */
  locale?: { language?: string; region?: string };
  /**
   * What the caller already holds about this payee (the form's current
   * values, or the stored row). Used to pick the right organisation and the
   * right branch of it, never written back -- see `PayeeLookupContext`.
   */
  known?: PayeeLookupContext;
}

/** The four contact fields a lookup may fill. */
export const CONTACT_LOOKUP_FIELDS = [
  "website",
  "address",
  "email",
  "phone",
] as const;
export type ContactLookupField = (typeof CONTACT_LOOKUP_FIELDS)[number];

/** At most this many candidates are offered for one name. */
export const MAX_CONTACT_LOOKUP_MATCHES = 3;

export interface PayeeContactSuggestion {
  /**
   * What tells this candidate apart from the others -- "Starbucks, 483 Bay
   * St, Toronto". Present only where the lookup found more than one
   * organisation or location the name could mean; the picker has nothing else
   * to show, so a candidate without one is not offered beside another.
   */
  label: string | null;
  website: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  source: ContactLookupSource;
  confidence: ContactLookupConfidence | null;
  /** The model's one-line justification. Shown, never persisted. */
  notes: string | null;
  /**
   * Fields whose value here is a *refinement* of one the caller already had
   * -- the full street address behind a typed "Toronto" -- rather than a fill
   * for an empty field. A refinement is never written by a lookup
   * (INV-PAYEE-001): the form applies it where the user can still see and undo
   * it before saving, and the detail card offers it for the user to apply.
   * A suggested value equal to the known one is not a refinement and is
   * dropped, so it can never be counted as something found.
   */
  refined: ContactLookupField[];
}

export interface PayeeContactLookupProvider {
  /**
   * The candidates the source found, best first, or an empty array when it
   * found nothing trustworthy. More than one only where the name genuinely
   * means more than one organisation or location -- the user picks. May
   * throw; the coordinator catches and classifies.
   */
  lookup(
    userId: string,
    input: PayeeContactLookupInput,
  ): Promise<PayeeContactSuggestion[]>;
}

export const PAYEE_CONTACT_LOOKUP_PROVIDER = Symbol(
  "PAYEE_CONTACT_LOOKUP_PROVIDER",
);

/**
 * What a lookup attempt established. Six states, because the caller has to
 * tell the user different things: `none` is "we looked and there was nothing",
 * `failed` is "we could not look" (and must never be shown as "nothing found"),
 * `no_provider`, `quota_exceeded` and `disabled` each name their own fix.
 */
export type ContactLookupReason =
  "ok" | "none" | "disabled" | "no_provider" | "quota_exceeded" | "failed";

/**
 * The candidates an `ok` outcome carries: at least one, best first. A tuple
 * rather than an array so a caller that needs "the answer" -- the automatic
 * paths, which have nobody to ask -- can read `suggestions[0]` without a
 * null check, while a caller with a user in front of it offers the rest.
 */
export type ContactLookupSuggestions = [
  PayeeContactSuggestion,
  ...PayeeContactSuggestion[],
];

export type ContactLookupOutcome =
  | {
      reason: "ok";
      suggestions: ContactLookupSuggestions;
      detail?: undefined;
    }
  | { reason: "none"; suggestions: []; detail?: undefined }
  | { reason: "disabled"; suggestions: []; detail?: undefined }
  | { reason: "no_provider"; suggestions: []; detail?: undefined }
  /**
   * The Google Places monthly cap is spent AND there is no AI provider to fall
   * back to. Its own reason rather than `no_provider`, because the two send the
   * user to opposite repairs: raise or wait out the cap, versus configure a
   * provider they may never have wanted.
   */
  | { reason: "quota_exceeded"; suggestions: []; detail?: undefined }
  | {
      reason: "failed";
      suggestions: [];
      /**
       * A message the user can act on, when there is one -- the relay's own
       * "agent is not connected" for instance. Absent for a generic failure.
       */
      detail?: string;
    };

/**
 * Thrown by an adapter that could not look at all -- as opposed to looking
 * and finding nothing, which is a `null` suggestion. The coordinator turns
 * it into the matching `ContactLookupOutcome` without logging it as a
 * defect, because both reasons are states the user can fix.
 */
export class ContactLookupUnavailableError extends Error {
  constructor(
    readonly reason: "no_provider" | "quota_exceeded" | "failed",
    readonly detail?: string,
    /**
     * The upstream HTTP status, where the failure was an ANSWERED refusal.
     *
     * Absent means nobody answered -- a timeout, a transport error, an open
     * breaker -- which is a different fact from a 4xx: the provider may still
     * have served (and billed) the request while we failed to hear the reply.
     * `PayeeLookupSettingsService.testKey` is the caller that needs the
     * distinction, to decide whether the quota slot it spent should be
     * handed back.
     */
    readonly httpStatus?: number,
  ) {
    super(detail ?? reason);
    this.name = "ContactLookupUnavailableError";
  }
}
