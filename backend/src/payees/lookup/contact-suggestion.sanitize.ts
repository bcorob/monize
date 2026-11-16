import { isEmail } from "class-validator";
import { normalizeWebsite } from "../../common/normalize-website";
import { sanitizePromptValue, stripHtml } from "../../common/sanitization.util";
import { PayeeLookupContext } from "./lookup-context";
import {
  CONTACT_LOOKUP_FIELDS,
  MAX_CONTACT_LOOKUP_MATCHES,
  ContactLookupConfidence,
  ContactLookupField,
  ContactLookupSource,
  PayeeContactSuggestion,
  UNVERIFIED_CONTACT_LOOKUP_SOURCES,
} from "./payee-contact-lookup.types";

/**
 * Caps match `CreatePayeeDto`, not the columns: a suggestion the form cannot
 * submit is not a suggestion. (`address` is TEXT in the table but 500 in the
 * DTO; `website` 2048, `email` 255, `phone` 50 are the same in both.)
 */
export const CONTACT_FIELD_MAX_LENGTH = {
  website: 2048,
  address: 500,
  email: 255,
  phone: 50,
} as const;

const NOTES_MAX_LENGTH = 300;
const LABEL_MAX_LENGTH = 120;

/** Strings a model writes when it means "nothing". */
const EMPTY_SENTINELS = new Set([
  "",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "not available",
  "not found",
  "not applicable",
  "-",
  "--",
]);

/** A phone number with fewer digits than this is a fragment, not a number. */
const MIN_PHONE_DIGITS = 7;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EMPTY_SENTINELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function sanitizeWebsite(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = normalizeWebsite(raw);
  if (!normalized || normalized.length > CONTACT_FIELD_MAX_LENGTH.website) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A hostname with no dot is a bare word ("acme"), never a public site.
  if (!url.hostname.includes(".")) return null;
  return normalized;
}

function sanitizeEmail(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw.length > CONTACT_FIELD_MAX_LENGTH.email) return null;
  return isEmail(raw) ? raw : null;
}

function sanitizePhone(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = (stripHtml(raw) ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length > CONTACT_FIELD_MAX_LENGTH.phone) return null;
  const digits = cleaned.replace(/\D/g, "").length;
  return digits >= MIN_PHONE_DIGITS ? cleaned : null;
}

/** An address longer than this many lines is prose, not an envelope. */
const MAX_ADDRESS_LINES = 6;

/**
 * An address keeps its line breaks: the prompt asks for envelope lines, the
 * form's textarea and the detail card (`whitespace-pre-line`) both show them,
 * and a maps link takes the whole string either way. Spaces collapse only
 * *within* a line; blank lines are dropped.
 */
function sanitizeAddress(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const lines = (stripHtml(raw) ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_ADDRESS_LINES) return null;
  const cleaned = lines.join("\n");
  return cleaned.length > CONTACT_FIELD_MAX_LENGTH.address ? null : cleaned;
}

function sanitizeConfidence(value: unknown): ContactLookupConfidence | null {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : null;
}

/** The picker's one line per candidate; same treatment as notes. */
function sanitizeLabel(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = sanitizePromptValue(stripHtml(raw) ?? "");
  return cleaned ? cleaned.slice(0, LABEL_MAX_LENGTH) : null;
}

function sanitizeNotes(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = sanitizePromptValue(stripHtml(raw) ?? "");
  return cleaned ? cleaned.slice(0, NOTES_MAX_LENGTH) : null;
}

/**
 * Is this suggested value the same fact the user already holds? Compared per
 * field the way the field is written rather than byte for byte, because
 * "starbucks.com" and "https://starbucks.com/" are one website and
 * "+1 416-555-0100" and "(416) 555-0100" are one number -- a suggestion equal
 * to what is on record is not a refinement, and counting it as one would show
 * the user a "found" that changes nothing.
 */
function isSameContactValue(
  field: ContactLookupField,
  suggested: string,
  known: string,
): boolean {
  switch (field) {
    case "website": {
      const a = normalizeWebsite(suggested);
      const b = normalizeWebsite(known);
      if (!a || !b) return false;
      // Trailing slash and case are presentation, not identity.
      return (
        a.toLowerCase().replace(/\/+$/, "") ===
        b.toLowerCase().replace(/\/+$/, "")
      );
    }
    case "email":
      return suggested.trim().toLowerCase() === known.trim().toLowerCase();
    case "phone": {
      // A country code is presentation too: "+1 416 555 0100" and
      // "(416) 555-0100" are one number, so a digit string that ends with the
      // other is the same number written more fully -- not a new fact.
      const a = suggested.replace(/\D/g, "");
      const b = known.replace(/\D/g, "");
      if (a.length < MIN_PHONE_DIGITS || b.length < MIN_PHONE_DIGITS) {
        return a === b && a.length > 0;
      }
      return a.length >= b.length ? a.endsWith(b) : b.endsWith(a);
    }
    case "address":
      return (
        normalizeAddressForCompare(suggested) ===
        normalizeAddressForCompare(known)
      );
  }
}

/** Line breaks, punctuation and case are how an address is written, not which one it is. */
function normalizeAddressForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s,.]+/g, " ")
    .trim();
}

/**
 * Which of the suggested values refine something the user already holds. A
 * field the user has not filled in is a fill, not a refinement, and never
 * appears here.
 */
function refinedFields(
  suggestion: Record<ContactLookupField, string | null>,
  known: PayeeLookupContext,
): ContactLookupField[] {
  return CONTACT_LOOKUP_FIELDS.filter((field) => {
    const value = suggestion[field];
    const current = known[field];
    return Boolean(
      value && current && !isSameContactValue(field, value, current),
    );
  });
}

/**
 * Turn whatever a data source returned into a suggestion the payee form and
 * the enrichment UPDATE can take verbatim -- or `null` when nothing survives.
 *
 * Two kinds of rule. Shape rules apply to every source: each field is a
 * string within the DTO's cap and format (a URL with a dotted host, an
 * address that is at least an email, a phone with enough digits), sentinel
 * strings mean absent, and HTML angle brackets are stripped as `@SanitizeHtml`
 * would. Trust rules apply by source: an answer that did not come from a
 * verified web search (`ai-knowledge`, `ai-relay`) keeps its address and
 * phone only at high confidence, because model memory is worst at exactly
 * those two -- a plausible street address for the wrong branch is worse than
 * an empty field.
 *
 * `known` is what the user already holds. With it, a field is answered three
 * ways instead of two: a fill (they had nothing), a refinement (they had
 * something and this is a different, fuller value -- listed in `refined` and
 * never written by a lookup), or an echo (the same fact they already have),
 * which is dropped so it cannot be reported as something found.
 */
export function sanitizeContactSuggestion(
  raw: unknown,
  source: ContactLookupSource,
  known?: PayeeLookupContext,
): PayeeContactSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const confidence = sanitizeConfidence(record.confidence);
  const unverified = UNVERIFIED_CONTACT_LOOKUP_SOURCES.includes(source);
  const keepLocalDetails = !unverified || confidence === "high";

  const values: Record<ContactLookupField, string | null> = {
    website: sanitizeWebsite(record.website),
    address: keepLocalDetails ? sanitizeAddress(record.address) : null,
    email: sanitizeEmail(record.email),
    phone: keepLocalDetails ? sanitizePhone(record.phone) : null,
  };

  // A value the user already holds, restated, is not something found: drop it
  // so `hasAny` below cannot turn an echo into an "ok" outcome.
  const refined = known ? refinedFields(values, known) : [];
  if (known) {
    for (const field of CONTACT_LOOKUP_FIELDS) {
      if (known[field] && !refined.includes(field)) values[field] = null;
    }
  }

  const suggestion: PayeeContactSuggestion = {
    label: sanitizeLabel(record.label),
    ...values,
    source,
    confidence,
    notes: sanitizeNotes(record.notes),
    refined,
  };

  const hasAny = CONTACT_LOOKUP_FIELDS.some((field) => values[field] !== null);
  return hasAny ? suggestion : null;
}

/**
 * Pull the JSON object out of a model answer that may wrap it in prose or a
 * code fence. Returns `null` for anything that is not one JSON object.
 */
export function parseContactJson(
  content: string,
): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The candidates in a source's answer, best first, each already through
 * `sanitizeContactSuggestion`. Empty when nothing survives.
 *
 * The shape is `{ matches: [...] }`, which is what the prompt asks for; a
 * bare object is read as a single match, because a model that answers the
 * older shape is answering, not failing. Two rules the caller depends on:
 * the list is capped at `MAX_CONTACT_LOOKUP_MATCHES`, and a candidate the
 * user could not tell apart from the one before it (no `label`, or the same
 * one) is dropped rather than offered -- a picker whose rows read alike is
 * worse than no picker.
 */
export function sanitizeContactSuggestions(
  raw: unknown,
  source: ContactLookupSource,
  known?: PayeeLookupContext,
): PayeeContactSuggestion[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const rawMatches = Array.isArray(record.matches) ? record.matches : [record];

  const suggestions: PayeeContactSuggestion[] = [];
  const seenLabels = new Set<string>();
  for (const rawMatch of rawMatches) {
    if (suggestions.length >= MAX_CONTACT_LOOKUP_MATCHES) break;
    const suggestion = sanitizeContactSuggestion(rawMatch, source, known);
    if (!suggestion) continue;
    if (suggestions.length > 0) {
      const label = suggestion.label?.toLowerCase();
      if (!label || seenLabels.has(label)) continue;
      seenLabels.add(label);
    } else if (suggestion.label) {
      seenLabels.add(suggestion.label.toLowerCase());
    }
    suggestions.push(suggestion);
  }
  return suggestions;
}
