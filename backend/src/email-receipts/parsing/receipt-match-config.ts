import {
  RECEIPT_MATCH_TEXT_FIELDS,
  type ReceiptMatchDefinition,
  type ReceiptMatchStrategy,
  type ReceiptMatchTextField,
} from "./receipt-parser.types";

/**
 * The matching a profile configures (design 5.5, spec 3a), resolved: every
 * default filled in, the tolerance in 1/10000 units. Pure; shared by the
 * validator (the tolerance text), the matcher and the candidate loader (the
 * window), so a profile means one thing everywhere.
 */

/** The strategies tried when a profile names none: today's truth table (spec 3). */
export const DEFAULT_MATCH_BY: readonly ReceiptMatchStrategy[] = [
  "orderId",
  "amount_payee",
  "amount_date",
];
/** The transaction fields `reference` and `orderId` look in by default: all of them. */
export const DEFAULT_REFERENCE_IN: readonly ReceiptMatchTextField[] =
  RECEIPT_MATCH_TEXT_FIELDS;
/** The candidate window, in calendar days around the purchase date. */
export const DEFAULT_DAYS_BEFORE = 3;
export const DEFAULT_DAYS_AFTER = 14;
export const MAX_DAYS_BEFORE = 60;
export const MAX_DAYS_AFTER = 90;
export const MIN_MATCH_DAYS = 0;
/** At most this many strategies (each of the four, once). */
export const MAX_MATCH_STRATEGIES = 4;
/** 1/10000 units: `5.00`, the largest tolerance a profile may set. */
export const MAX_TOLERANCE_UNITS = 50_000;
const MONEY_UNITS = 10_000;
const MAX_TOLERANCE_FRACTION_DIGITS = 4;

export interface ResolvedMatchConfig {
  by: readonly ReceiptMatchStrategy[];
  referenceIn: readonly ReceiptMatchTextField[];
  daysBefore: number;
  daysAfter: number;
  /** 1/10000 units; 0 is an exact amount. */
  toleranceUnits: number;
}

/**
 * A tolerance text as 1/10000 units, or null when it is not one: digits, then
 * optionally a point and one to four digits, nothing else (no sign, no
 * exponent, no separator). Integer arithmetic only; the bound (`5.00`) is the
 * caller's check, so an over-large value is distinguishable from a malformed one.
 */
export function parseToleranceUnits(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  if (whole.length < 1 || whole.length > 3) return null;
  if (dot !== -1 && fraction.length < 1) return null;
  if (fraction.length > MAX_TOLERANCE_FRACTION_DIGITS) return null;
  for (const part of [whole, fraction]) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      if (code < 0x30 || code > 0x39) return null;
    }
  }
  const padded = fraction.padEnd(MAX_TOLERANCE_FRACTION_DIGITS, "0");
  return Number(whole) * MONEY_UNITS + Number(padded);
}

/** A profile's `match` section (or none) with every default filled in. */
export function resolveMatchConfig(
  match?: ReceiptMatchDefinition | null,
): ResolvedMatchConfig {
  const tolerance =
    match?.amountTolerance === undefined
      ? 0
      : (parseToleranceUnits(match.amountTolerance) ?? 0);
  return {
    by: match?.by && match.by.length > 0 ? match.by : DEFAULT_MATCH_BY,
    referenceIn:
      match?.referenceIn && match.referenceIn.length > 0
        ? match.referenceIn
        : DEFAULT_REFERENCE_IN,
    daysBefore: match?.daysBefore ?? DEFAULT_DAYS_BEFORE,
    daysAfter: match?.daysAfter ?? DEFAULT_DAYS_AFTER,
    toleranceUnits: Math.min(Math.max(tolerance, 0), MAX_TOLERANCE_UNITS),
  };
}

/** The config of a profile that says nothing about matching. */
export const DEFAULT_MATCH_CONFIG: ResolvedMatchConfig = resolveMatchConfig();

/**
 * The `match` section a profile effectively has: every default filled in, so a
 * view, a form or an AI draft shows what the matcher will do. `reference`
 * leads the strategies only when the profile reads a `reference` field.
 */
export function effectiveMatchDefinition(definition: {
  reference?: unknown[];
  match?: ReceiptMatchDefinition | null;
}): Required<ReceiptMatchDefinition> {
  const match = definition.match;
  const hasReference =
    Array.isArray(definition.reference) && definition.reference.length > 0;
  const defaultBy: ReceiptMatchStrategy[] = hasReference
    ? ["reference", ...DEFAULT_MATCH_BY]
    : [...DEFAULT_MATCH_BY];
  return {
    by: match?.by && match.by.length > 0 ? [...match.by] : defaultBy,
    referenceIn:
      match?.referenceIn && match.referenceIn.length > 0
        ? [...match.referenceIn]
        : [...DEFAULT_REFERENCE_IN],
    daysBefore: match?.daysBefore ?? DEFAULT_DAYS_BEFORE,
    daysAfter: match?.daysAfter ?? DEFAULT_DAYS_AFTER,
    amountTolerance: match?.amountTolerance ?? "0.00",
  };
}
