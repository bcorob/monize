import { sanitizePromptValue, stripHtml } from "../../common/sanitization.util";

/**
 * What the user already holds about a payee, handed to the lookup so it
 * resolves the right organisation and the right *place*: an address reading
 * only "Toronto" is not an answer to be preserved, it is a constraint on
 * which of a chain's branches the answer may come from.
 *
 * Every value here is user free text on its way into a model prompt, so it is
 * sanitized (control characters and line breaks out, HTML stripped) and
 * capped. `notes` is the only field that is not also a contact column; it is
 * context only and no lookup ever writes it.
 */
export const LOOKUP_CONTEXT_FIELDS = [
  "website",
  "address",
  "email",
  "phone",
  "notes",
] as const;
export type LookupContextField = (typeof LOOKUP_CONTEXT_FIELDS)[number];

export type PayeeLookupContext = Partial<Record<LookupContextField, string>>;

/**
 * Caps match the contact DTO's, except `notes`: a payee note can be long, and
 * the part of it that identifies a business is at the front. A cap here is a
 * cost and prompt-budget bound, not validation -- the value is already stored.
 */
export const LOOKUP_CONTEXT_MAX_LENGTH: Record<LookupContextField, number> = {
  website: 2048,
  address: 500,
  email: 255,
  phone: 50,
  notes: 500,
};

/** Human labels the prompt uses. Not translated: the model is prompted in English. */
export const LOOKUP_CONTEXT_LABELS: Record<LookupContextField, string> = {
  website: "website",
  address: "address",
  email: "email",
  phone: "phone",
  notes: "notes",
};

/**
 * Build the context block from whatever the caller holds. Returns `undefined`
 * when nothing survives, so a caller can tell "no context" from "empty
 * context" without inspecting keys.
 */
export function buildLookupContext(
  source: Partial<Record<LookupContextField, string | null | undefined>>,
): PayeeLookupContext | undefined {
  const context: PayeeLookupContext = {};
  for (const field of LOOKUP_CONTEXT_FIELDS) {
    const raw = source[field];
    if (typeof raw !== "string") continue;
    const cleaned = sanitizePromptValue(stripHtml(raw) ?? "");
    if (!cleaned) continue;
    context[field] = cleaned.slice(0, LOOKUP_CONTEXT_MAX_LENGTH[field]);
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

/** True when the context carries something that pins the payee to a place. */
export function hasLocationContext(context?: PayeeLookupContext): boolean {
  return Boolean(context?.address);
}
