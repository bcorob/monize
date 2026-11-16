import { UUID_REGEX } from "../../common/query-param-utils";
import {
  isReceiptDomain,
  normalizeReceiptDomain,
} from "../parsers/dto/receipt-domain.validator";
import {
  MAX_CAPTURES_PER_PATTERN,
  parseGlob,
} from "../../transaction-rules/rule-glob-capture";
import { patternParts } from "./receipt-glob";
import {
  MAX_DAYS_AFTER,
  MAX_DAYS_BEFORE,
  MAX_MATCH_STRATEGIES,
  MAX_TOLERANCE_UNITS,
  MIN_MATCH_DAYS,
  parseToleranceUnits,
} from "./receipt-match-config";
import {
  MAX_CATEGORY_RULES,
  MAX_LINK_DAYS_BEFORE,
  MAX_LINK_DOMAINS,
  MAX_BALANCE_TOLERANCE_UNITS,
  MAX_PROFILE_CATEGORY_NAME_LENGTH,
  MAX_PROFILE_TAG_LENGTH,
  MAX_LABEL_WITHIN,
  MAX_LINE_GUARDS,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_LINES,
  MAX_PATTERNS_PER_FIELD,
  MAX_RECORD_STEPS,
  MAX_SECTION_MARKER_LENGTH,
  MAX_SKIP_LINES,
  MAX_STEP_ALTERNATIVES,
  MIN_LABEL_WITHIN,
  RECEIPT_DISCARD_MODES,
  RECEIPT_LINES_SOURCES,
  RECEIPT_MATCH_STRATEGIES,
  RECEIPT_MATCH_TEXT_FIELDS,
  RECEIPT_PARSER_ROLES,
  RECEIPT_PARSER_VERSION,
  ReceiptBlockItemsDefinition,
  ReceiptCategoryRule,
  ReceiptCategoryRuleField,
  ReceiptDiscardMode,
  ReceiptFieldEntry,
  ReceiptItemsDefinition,
  ReceiptLabelledPattern,
  ReceiptLinkDefinition,
  ReceiptLinesSource,
  ReceiptMatchDefinition,
  ReceiptMatchStrategy,
  ReceiptMatchTextField,
  ReceiptParserDefinition,
  ReceiptParserRole,
  ReceiptRecordStep,
  ReceiptSingleItemsDefinition,
  ReceiptTradeAccountRule,
  ReceiptTradeCurrencyMarker,
  ReceiptTradeDefinition,
  MAX_TRADE_ACCOUNT_RULES,
  MAX_TRADE_CURRENCY_MARKERS,
} from "./receipt-parser.types";
import { isRecord } from "../../common/helpers/is-record";
import { hasControlCharacter } from "../../common/helpers/has-control-character";

/**
 * The one validator of a receipt parser definition (design 5.2 and 5.4). The
 * form, the API and the AI draft all pass through it, so a stored definition has the
 * same shape whoever wrote it. Pure and total: it never throws, whatever it is
 * given, and reports every problem it finds (up to a cap) as a path and a
 * machine-readable code. Ownership of the category ids is not checked here;
 * `collectParserCategoryIds` lists them for the service that does.
 */

/** A validator result stays small however hostile the input is. */
const MAX_REPORTED_ERRORS = 50;

export interface ReceiptParserValidationError {
  /** Where the problem is, e.g. `items.patterns[1]` or `categoryRules[0].categoryId`. */
  path: string;
  /**
   * `not_object`, `unknown_key`, `unsupported_version`, `invalid_type`,
   * `empty`, `too_many`, `too_long`, `control_character`, `malformed_capture`,
   * `too_many_captures`, `duplicate_capture`, `capture_not_allowed`,
   * `capture_missing`, `capture_conflict`, `invalid_uuid`, `out_of_range`
   * (`within`), `items_patterns_and_record`, `items_shape_missing`,
   * `items_single_conflict`, `skip_lines_need_record`,
   * `join_wrapped_needs_patterns`, `record_name_missing`, `invalid_value` (a
   * category rule `field`, the top-level `source` or `discard`, a `match` strategy, field or
   * tolerance), `duplicate_entry` (a repeated `match` strategy or field),
   * `reference_field_missing` (`match.by` names `reference` and the profile reads
   * none), `too_many_lines` (a multi-line pattern over `MAX_PATTERN_LINES`
   * parts), `line_break_not_allowed` (a multi-line pattern where one text is
   * matched: a category rule's item name or payee, a trade account rule).
   *
   * Linked receipts: `role_invalid` (`role` is not one of the three),
   * `link_key_requires_component` (`linkKey` without `role: "component"`),
   * `link_key_missing` (a component without `linkKey`),
   * `link_capture_requires_settlement` (`{link}` or `{instalment}` in an item
   * pattern or record step of a profile that is not a settlement),
   * `link_requires_settlement` (a `link` section without `role: "settlement"`),
   * `link_domain_invalid` (a `link.fromDomains` entry the profile domain rules
   * refuse, or a list that is empty or over 10), `link_days_invalid`
   * (`link.daysBefore` is not an integer from 0 to 365), `role_trade_conflict`
   * (a `trade` section with a role other than `standalone`).
   */
  code: string;
}

export type ReceiptParserValidation =
  | { ok: true; definition: ReceiptParserDefinition }
  | { ok: false; errors: ReceiptParserValidationError[] };

/** The capture names a pattern of each field may hold, and the ones it must hold. */
interface FieldCaptures {
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

const ORDER_ID_CAPTURES: FieldCaptures = {
  allowed: ["orderid"],
  required: ["orderid"],
};
const PAYEE_CAPTURES: FieldCaptures = {
  allowed: ["payee"],
  required: ["payee"],
};
const REFERENCE_CAPTURES: FieldCaptures = {
  allowed: ["reference"],
  required: ["reference"],
};
const SINGLE_NAME_CAPTURES: FieldCaptures = {
  allowed: ["name"],
  required: ["name"],
};
const captureOf = (name: string): FieldCaptures => ({
  allowed: [name],
  required: [name],
});
const AMOUNT_CAPTURES: FieldCaptures = {
  allowed: ["amount"],
  required: ["amount"],
};
/** The item captures only a settlement part may hold. */
const LINK_ITEM_CAPTURES: readonly string[] = ["link", "instalment"];
const ITEM_CAPTURES: FieldCaptures = {
  allowed: ["name", "amount", "price", "qty", ...LINK_ITEM_CAPTURES],
  required: ["name"],
};

/** A record step may hold any item capture; the record as a whole must name and price the item. */
const RECORD_STEP_CAPTURES: FieldCaptures = {
  allowed: ITEM_CAPTURES.allowed,
  required: [],
};

const TOP_LEVEL_KEYS: readonly string[] = [
  "version",
  "source",
  "orderId",
  "total",
  "paid",
  "shipping",
  "fees",
  "discount",
  "payee",
  "reference",
  "match",
  "role",
  "linkKey",
  "link",
  "tag",
  "aiCategories",
  "balanceTolerance",
  "trade",
  "items",
  "categoryRules",
  "defaultCategoryId",
  "shippingCategoryId",
  "feesCategoryId",
  "defaultCategory",
  "shippingCategory",
  "feesCategory",
  "requireLine",
  "skipIfLine",
  "waitIfLine",
  "discard",
];
const TRADE_KEYS: readonly string[] = [
  "action",
  "symbol",
  "quantity",
  "total",
  "price",
  "commission",
  "date",
  "account",
  "accountRules",
  "defaultAccountId",
  "currencyMarkers",
];
const TRADE_ACCOUNT_RULE_KEYS: readonly string[] = [
  "match",
  "accountId",
  "currency",
];
const TRADE_CURRENCY_MARKER_KEYS: readonly string[] = ["match", "currency"];
/** A currency as an account rule or a marker names it: a 3-letter ISO code, upper case. */
const CURRENCY_CODE = /^[A-Z]{3}$/;
/** The top-level keys a profile with a `trade` section may also hold. */
const TRADE_COMPATIBLE_KEYS: readonly string[] = [
  "version",
  "source",
  "role",
  "trade",
  "requireLine",
  "skipIfLine",
  "waitIfLine",
  "discard",
];
const ITEMS_KEYS: readonly string[] = ["startAfter", "stopAt", "patterns"];
/** The keys of the multi-line item shape. */
const ITEMS_KEYS_OTHER: readonly string[] = [
  "skipLines",
  "record",
  "single",
  "joinWrapped",
];
const RULE_FIELDS: readonly ReceiptCategoryRuleField[] = [
  "item",
  "payee",
  "line",
];
const MATCH_KEYS: readonly string[] = [
  "by",
  "referenceIn",
  "daysBefore",
  "daysAfter",
  "amountTolerance",
];
const LINK_KEYS: readonly string[] = ["fromDomains", "daysBefore"];
const LABELLED_KEYS: readonly string[] = ["label", "value", "within"];
const RECORD_STEP_KEYS: readonly string[] = ["line", "optional"];
const NO_CAPTURES: FieldCaptures = { allowed: [], required: [] };
const CATEGORY_RULE_KEYS: readonly string[] = ["match", "categoryId", "field"];

/** Collects errors up to the cap; a full collector ignores further reports. */
class Errors {
  readonly list: ReceiptParserValidationError[] = [];
  add(path: string, code: string): void {
    if (this.list.length < MAX_REPORTED_ERRORS) this.list.push({ path, code });
  }
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: Errors,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.add(prefix + key, "unknown_key");
  }
}

function asArray(
  value: unknown,
  path: string,
  errors: Errors,
): unknown[] | null {
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length > MAX_PATTERNS_PER_FIELD) {
    errors.add(path, "too_many");
    return null;
  }
  return value;
}

/**
 * A glob pattern for one field: bounded, well formed, with only the allowed
 * captures. A multi-line pattern (parts joined by `\n`) has up to
 * `MAX_PATTERN_LINES` parts, none empty, and its captures are counted over
 * all of them; `lineBreaks` false refuses one, where the pattern is matched
 * against one text rather than the email's lines.
 */
function checkPattern(
  value: unknown,
  path: string,
  captures: FieldCaptures,
  errors: Errors,
  lineBreaks = true,
): boolean {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return false;
  }
  if (value.trim() === "") {
    errors.add(path, "empty");
    return false;
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    errors.add(path, "too_long");
    return false;
  }
  // A line never holds a line break or another control character.
  if (hasControlCharacter(value)) {
    errors.add(path, "control_character");
    return false;
  }
  const parts = patternParts(value);
  if (parts.length > 1 && !lineBreaks) {
    errors.add(path, "line_break_not_allowed");
    return false;
  }
  if (parts.length > MAX_PATTERN_LINES) {
    errors.add(path, "too_many_lines");
    return false;
  }
  // An empty part would match only an empty line, and no line is empty.
  if (parts.some((part) => part.trim() === "")) {
    errors.add(path, "empty");
    return false;
  }
  const globs = parts.map((part) => parseGlob(part));
  const names = globs.flatMap((glob) => glob.captureNames);
  const before = errors.list.length;
  if (globs.some((glob) => glob.malformed.length > 0)) {
    errors.add(path, "malformed_capture");
  }
  if (names.length > MAX_CAPTURES_PER_PATTERN) {
    errors.add(path, "too_many_captures");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) errors.add(path, "duplicate_capture");
    seen.add(name);
    if (!captures.allowed.includes(name)) {
      errors.add(path, "capture_not_allowed");
    }
  }
  for (const name of captures.required) {
    if (!seen.has(name)) errors.add(path, "capture_missing");
  }
  return errors.list.length === before;
}

/** A labelled entry: a capture-free `label`, the field's own `value`, and `within` (1 to 10). */
function checkLabelled(
  entry: Record<string, unknown>,
  path: string,
  captures: FieldCaptures,
  errors: Errors,
): ReceiptLabelledPattern | null {
  const before = errors.list.length;
  checkKeys(entry, LABELLED_KEYS, `${path}.`, errors);
  const label = checkPattern(entry.label, `${path}.label`, NO_CAPTURES, errors);
  const value = checkPattern(entry.value, `${path}.value`, captures, errors);
  let within: number | undefined;
  if (entry.within !== undefined) {
    if (typeof entry.within !== "number" || !Number.isInteger(entry.within)) {
      errors.add(`${path}.within`, "invalid_type");
    } else if (
      entry.within < MIN_LABEL_WITHIN ||
      entry.within > MAX_LABEL_WITHIN
    ) {
      errors.add(`${path}.within`, "out_of_range");
    } else {
      within = entry.within;
    }
  }
  if (!label || !value || errors.list.length > before) return null;
  const out: ReceiptLabelledPattern = {
    label: entry.label as string,
    value: entry.value as string,
  };
  if (within !== undefined) out.within = within;
  return out;
}

/**
 * A field's entry list: each entry a glob with the field's captures or, when
 * `labelled`, a `{label, value, within}` object. A list of plain globs (such
 * as `items.patterns`) refuses an object as `invalid_type`.
 */
function checkPatternList(
  value: unknown,
  path: string,
  captures: FieldCaptures,
  errors: Errors,
  minimum: number,
  labelled = true,
): ReceiptFieldEntry[] | null {
  const list = asArray(value, path, errors);
  if (list === null) return null;
  if (list.length < minimum) {
    errors.add(path, "empty");
    return null;
  }
  let valid = true;
  const out: ReceiptFieldEntry[] = [];
  list.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (labelled && isRecord(entry)) {
      const parsed = checkLabelled(entry, entryPath, captures, errors);
      if (parsed !== null) out.push(parsed);
      else valid = false;
    } else if (checkPattern(entry, entryPath, captures, errors)) {
      out.push(entry as string);
    } else {
      valid = false;
    }
  });
  return valid ? out : null;
}

/** An item pattern also needs `amount`, or `price` (optionally with `qty`), never both. */
function checkItemPriceCaptures(
  patterns: readonly string[],
  path: string,
  errors: Errors,
): void {
  patterns.forEach((pattern, index) => {
    const names = parseGlob(pattern).captureNames;
    const hasAmount = names.includes("amount");
    const hasPrice = names.includes("price");
    if (hasAmount && hasPrice) {
      errors.add(`${path}[${index}]`, "capture_conflict");
    } else if (!hasAmount && !hasPrice) {
      errors.add(`${path}[${index}]`, "capture_missing");
    }
  });
}

function checkMarker(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.trim() === "") {
    errors.add(path, "empty");
    return null;
  }
  if (value.length > MAX_SECTION_MARKER_LENGTH) {
    errors.add(path, "too_long");
    return null;
  }
  return value;
}

function checkUuid(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  if (!UUID_REGEX.test(value)) {
    errors.add(path, "invalid_uuid");
    return null;
  }
  return value;
}

/** A list of capture-free globs: `skipLines` (up to 10) and the line guards (up to 10). */
function checkGlobList(
  value: unknown,
  path: string,
  max: number,
  errors: Errors,
): string[] | null {
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length > max) {
    errors.add(path, "too_many");
    return null;
  }
  let valid = true;
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (checkPattern(entry, `${path}[${index}]`, NO_CAPTURES, errors)) {
      out.push(entry as string);
    } else {
      valid = false;
    }
  });
  return valid ? out : null;
}

/**
 * The `line` of a record step: a glob, or 1 to 5 alternative globs tried in
 * order. The names an alternative captures are the step's; every alternative
 * holds each name once and `amount` and `price` never together.
 */
function checkStepLine(
  value: unknown,
  path: string,
  settlement: boolean,
  errors: Errors,
): { line: string | string[]; names: Set<string> } | null {
  const before = errors.list.length;
  const alternatives: unknown[] = Array.isArray(value) ? value : [value];
  if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.add(path, "empty");
      return null;
    }
    if (value.length > MAX_STEP_ALTERNATIVES) {
      errors.add(path, "too_many");
      return null;
    }
  }
  const names = new Set<string>();
  alternatives.forEach((alternative, index) => {
    const at = Array.isArray(value) ? `${path}[${index}]` : path;
    if (!checkPattern(alternative, at, RECORD_STEP_CAPTURES, errors)) return;
    const found = parseGlob(alternative as string).captureNames;
    if (found.includes("amount") && found.includes("price")) {
      errors.add(at, "capture_conflict");
    }
    if (!settlement && found.some((n) => LINK_ITEM_CAPTURES.includes(n))) {
      errors.add(at, "link_capture_requires_settlement");
    }
    found.forEach((name) => names.add(name));
  });
  return errors.list.length === before
    ? { line: value as string | string[], names }
    : null;
}

/**
 * The `record` of block items: 1 to 6 steps, each a glob (or alternatives) over
 * one line with the item captures and an optional flag. Across the steps a
 * capture name belongs to one step, and the record names the item (`name`). An
 * item the record gives no amount or price takes the email's total when it is
 * the only item.
 */
function checkRecord(
  value: unknown,
  settlement: boolean,
  errors: Errors,
): ReceiptRecordStep[] | null {
  const path = "items.record";
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length === 0) {
    errors.add(path, "empty");
    return null;
  }
  if (value.length > MAX_RECORD_STEPS) {
    errors.add(path, "too_many");
    return null;
  }
  const before = errors.list.length;
  const out: ReceiptRecordStep[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const stepPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.add(stepPath, "invalid_type");
      return;
    }
    checkKeys(entry, RECORD_STEP_KEYS, `${stepPath}.`, errors);
    const linePath = `${stepPath}.line`;
    const line = checkStepLine(entry.line, linePath, settlement, errors);
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      errors.add(`${stepPath}.optional`, "invalid_type");
    }
    if (line === null) return;
    if ([...line.names].some((name) => seen.has(name))) {
      errors.add(linePath, "duplicate_capture");
    }
    line.names.forEach((name) => seen.add(name));
    const step: ReceiptRecordStep = { line: line.line };
    if (typeof entry.optional === "boolean") step.optional = entry.optional;
    out.push(step);
  });
  if (errors.list.length > before) return null;
  if (!seen.has("name")) errors.add(path, "record_name_missing");
  return errors.list.length === before ? out : null;
}

/** The `single` of items: one item whose `name` glob captures `{name}`. */
function checkSingle(value: unknown, errors: Errors): { name: string } | null {
  if (!isRecord(value)) {
    errors.add("items.single", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, ["name"], "items.single.", errors);
  checkPattern(value.name, "items.single.name", SINGLE_NAME_CAPTURES, errors);
  return errors.list.length === before ? { name: value.name as string } : null;
}

type ItemsDefinition =
  | ReceiptItemsDefinition
  | ReceiptBlockItemsDefinition
  | ReceiptSingleItemsDefinition;

/**
 * The item section: exactly one of `patterns` (one item per line, with
 * optional `joinWrapped`), `record` (items that span lines, with optional
 * `skipLines`) and `single` (one item for the whole email).
 */
function checkItems(
  value: unknown,
  settlement: boolean,
  errors: Errors,
): ItemsDefinition | null {
  if (!isRecord(value)) {
    errors.add("items", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, [...ITEMS_KEYS, ...ITEMS_KEYS_OTHER], "items.", errors);
  const markers: { startAfter?: string; stopAt?: string } = {};
  if (value.startAfter !== undefined) {
    const marker = checkMarker(value.startAfter, "items.startAfter", errors);
    if (marker !== null) markers.startAfter = marker;
  }
  if (value.stopAt !== undefined) {
    const marker = checkMarker(value.stopAt, "items.stopAt", errors);
    if (marker !== null) markers.stopAt = marker;
  }

  const hasPatterns = value.patterns !== undefined;
  const hasRecord = value.record !== undefined;
  const hasSingle = value.single !== undefined;
  if (hasPatterns && hasRecord && !hasSingle) {
    errors.add("items", "items_patterns_and_record");
    return null;
  }
  if ([hasPatterns, hasRecord, hasSingle].filter(Boolean).length > 1) {
    errors.add("items", "items_single_conflict");
    return null;
  }
  if (!hasPatterns && !hasRecord && !hasSingle) {
    errors.add("items", "items_shape_missing");
    return null;
  }
  if (value.joinWrapped !== undefined) {
    if (typeof value.joinWrapped !== "boolean") {
      errors.add("items.joinWrapped", "invalid_type");
    } else if (!hasPatterns) {
      errors.add("items.joinWrapped", "join_wrapped_needs_patterns");
    }
  }

  if (hasSingle) {
    if (value.skipLines !== undefined) {
      errors.add("items.skipLines", "skip_lines_need_record");
    }
    const single = checkSingle(value.single, errors);
    return errors.list.length === before && single !== null
      ? { ...markers, single }
      : null;
  }

  if (hasRecord) {
    const record = checkRecord(value.record, settlement, errors);
    let skipLines: string[] | undefined;
    if (value.skipLines !== undefined) {
      skipLines =
        checkGlobList(
          value.skipLines,
          "items.skipLines",
          MAX_SKIP_LINES,
          errors,
        ) ?? undefined;
    }
    if (errors.list.length > before || record === null) return null;
    return {
      ...markers,
      ...(skipLines !== undefined ? { skipLines } : {}),
      record,
    };
  }

  if (value.skipLines !== undefined) {
    errors.add("items.skipLines", "skip_lines_need_record");
  }
  const patterns = checkPatternList(
    value.patterns,
    "items.patterns",
    ITEM_CAPTURES,
    errors,
    1,
    false,
  );
  if (patterns !== null) {
    checkItemPriceCaptures(patterns as string[], "items.patterns", errors);
    if (!settlement) {
      (patterns as string[]).forEach((pattern, index) => {
        if (
          parseGlob(pattern).captureNames.some((n) =>
            LINK_ITEM_CAPTURES.includes(n),
          )
        ) {
          errors.add(
            `items.patterns[${index}]`,
            "link_capture_requires_settlement",
          );
        }
      });
    }
  }
  return errors.list.length === before && patterns !== null
    ? {
        ...markers,
        patterns: patterns as string[],
        ...(value.joinWrapped === true ? { joinWrapped: true } : {}),
      }
    : null;
}

function checkCategoryRules(
  value: unknown,
  errors: Errors,
): ReceiptCategoryRule[] | null {
  if (!Array.isArray(value)) {
    errors.add("categoryRules", "invalid_type");
    return null;
  }
  if (value.length > MAX_CATEGORY_RULES) {
    errors.add("categoryRules", "too_many");
    return null;
  }
  const before = errors.list.length;
  const out: ReceiptCategoryRule[] = [];
  value.forEach((entry, index) => {
    const path = `categoryRules[${index}]`;
    if (!isRecord(entry)) {
      errors.add(path, "invalid_type");
      return;
    }
    checkKeys(entry, CATEGORY_RULE_KEYS, `${path}.`, errors);
    // A category rule is a capture-less glob over an item name, the payee or a
    // line; only a `line` rule reads the email's lines, so only it may span them.
    const noCaptures: FieldCaptures = { allowed: [], required: [] };
    const matchOk = checkPattern(
      entry.match,
      `${path}.match`,
      noCaptures,
      errors,
      entry.field === "line",
    );
    const categoryId = checkUuid(
      entry.categoryId,
      `${path}.categoryId`,
      errors,
    );
    let field: ReceiptCategoryRuleField | undefined;
    let fieldOk = true;
    if (entry.field !== undefined) {
      if (typeof entry.field !== "string") {
        errors.add(`${path}.field`, "invalid_type");
        fieldOk = false;
      } else if (
        !RULE_FIELDS.includes(entry.field as ReceiptCategoryRuleField)
      ) {
        errors.add(`${path}.field`, "invalid_value");
        fieldOk = false;
      } else {
        field = entry.field as ReceiptCategoryRuleField;
      }
    }
    if (matchOk && categoryId !== null && fieldOk) {
      out.push({
        match: entry.match as string,
        categoryId,
        ...(field === undefined ? {} : { field }),
      });
    }
  });
  return errors.list.length === before ? out : null;
}

/** A whole number of days in `[MIN_MATCH_DAYS, max]`, or null with the error recorded. */
function checkDays(
  value: unknown,
  path: string,
  max: number,
  errors: Errors,
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value < MIN_MATCH_DAYS || value > max) {
    errors.add(path, "out_of_range");
    return null;
  }
  return value;
}

/** A list of distinct values from a closed set (`match.by`, `match.referenceIn`). */
function checkChoiceList<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  max: number,
  errors: Errors,
): T[] | null {
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length === 0) {
    errors.add(path, "empty");
    return null;
  }
  if (value.length > max) {
    errors.add(path, "too_many");
    return null;
  }
  const before = errors.list.length;
  const seen = new Set<string>();
  const out: T[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== "string") {
      errors.add(at, "invalid_type");
    } else if (!allowed.includes(entry as T)) {
      errors.add(at, "invalid_value");
    } else if (seen.has(entry)) {
      errors.add(at, "duplicate_entry");
    } else {
      seen.add(entry);
      out.push(entry as T);
    }
  });
  return errors.list.length === before ? out : null;
}

/**
 * The `match` section (design 5.5): which strategies identify the transaction,
 * in order; which transaction fields `reference` and `orderId` look in; the
 * window in days either side of the purchase date; the amount tolerance as a
 * decimal string up to 5.00. `reference` in `by` needs the profile to read one.
 */
function checkMatch(
  value: unknown,
  hasReferenceField: boolean,
  errors: Errors,
): ReceiptMatchDefinition | null {
  if (!isRecord(value)) {
    errors.add("match", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, MATCH_KEYS, "match.", errors);
  const out: ReceiptMatchDefinition = {};
  if (value.by !== undefined) {
    const by = checkChoiceList<ReceiptMatchStrategy>(
      value.by,
      "match.by",
      RECEIPT_MATCH_STRATEGIES,
      MAX_MATCH_STRATEGIES,
      errors,
    );
    if (by !== null) {
      out.by = by;
      if (by.includes("reference") && !hasReferenceField) {
        errors.add("match.by", "reference_field_missing");
      }
    }
  }
  if (value.referenceIn !== undefined) {
    const fields = checkChoiceList<ReceiptMatchTextField>(
      value.referenceIn,
      "match.referenceIn",
      RECEIPT_MATCH_TEXT_FIELDS,
      RECEIPT_MATCH_TEXT_FIELDS.length,
      errors,
    );
    if (fields !== null) out.referenceIn = fields;
  }
  if (value.daysBefore !== undefined) {
    const days = checkDays(
      value.daysBefore,
      "match.daysBefore",
      MAX_DAYS_BEFORE,
      errors,
    );
    if (days !== null) out.daysBefore = days;
  }
  if (value.daysAfter !== undefined) {
    const days = checkDays(
      value.daysAfter,
      "match.daysAfter",
      MAX_DAYS_AFTER,
      errors,
    );
    if (days !== null) out.daysAfter = days;
  }
  if (value.amountTolerance !== undefined) {
    if (typeof value.amountTolerance !== "string") {
      errors.add("match.amountTolerance", "invalid_type");
    } else {
      const units = parseToleranceUnits(value.amountTolerance);
      if (units === null) {
        errors.add("match.amountTolerance", "invalid_value");
      } else if (units > MAX_TOLERANCE_UNITS) {
        errors.add("match.amountTolerance", "out_of_range");
      } else {
        out.amountTolerance = value.amountTolerance;
      }
    }
  }
  return errors.list.length === before ? out : null;
}

/**
 * The `link` section of a settlement: `fromDomains` (1 to 10 sender domains,
 * checked by the rule the profile's own `fromDomains` use and stored
 * normalized) and `daysBefore` (an integer from 0 to 365).
 */
function checkLink(
  value: unknown,
  errors: Errors,
): ReceiptLinkDefinition | null {
  if (!isRecord(value)) {
    errors.add("link", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, LINK_KEYS, "link.", errors);
  const out: ReceiptLinkDefinition = {};
  if (value.fromDomains !== undefined) {
    const path = "link.fromDomains";
    const list = value.fromDomains;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_LINK_DOMAINS
    ) {
      errors.add(path, "link_domain_invalid");
    } else {
      const domains: string[] = [];
      list.forEach((entry, index) => {
        const domain = normalizeReceiptDomain(entry);
        if (isReceiptDomain(domain)) domains.push(domain as string);
        else errors.add(`${path}[${index}]`, "link_domain_invalid");
      });
      if (domains.length === list.length) out.fromDomains = domains;
    }
  }
  if (value.daysBefore !== undefined) {
    const days = value.daysBefore;
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > MAX_LINK_DAYS_BEFORE
    ) {
      errors.add("link.daysBefore", "link_days_invalid");
    } else {
      out.daysBefore = days;
    }
  }
  return errors.list.length === before ? out : null;
}

/** The tag a profile adds: 1 to 50 characters once trimmed, no control character. */
function checkTag(value: unknown, errors: Errors): string | null {
  if (typeof value !== "string") {
    errors.add("tag", "invalid_type");
    return null;
  }
  const tag = value.trim();
  if (tag === "") {
    errors.add("tag", "empty");
    return null;
  }
  if (tag.length > MAX_PROFILE_TAG_LENGTH) {
    errors.add("tag", "too_long");
    return null;
  }
  if (hasControlCharacter(tag)) {
    errors.add("tag", "control_character");
    return null;
  }
  return tag;
}

/** A category name a profile gives: 1 to 100 characters once trimmed, no control character. */
function checkCategoryName(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  const name = value.trim();
  if (name === "") {
    errors.add(path, "empty");
    return null;
  }
  if (name.length > MAX_PROFILE_CATEGORY_NAME_LENGTH) {
    errors.add(path, "too_long");
    return null;
  }
  if (hasControlCharacter(name)) {
    errors.add(path, "control_character");
    return null;
  }
  return name;
}

/** `balanceTolerance`: a decimal text from `"0"` to `"0.05"` (the amountTolerance grammar, a tighter bound). */
function checkBalanceTolerance(value: unknown, errors: Errors): string | null {
  if (typeof value !== "string") {
    errors.add("balanceTolerance", "invalid_type");
    return null;
  }
  const units = parseToleranceUnits(value);
  if (units === null) {
    errors.add("balanceTolerance", "invalid_value");
    return null;
  }
  if (units > MAX_BALANCE_TOLERANCE_UNITS) {
    errors.add("balanceTolerance", "out_of_range");
    return null;
  }
  return value;
}

function checkTradeAccountRules(
  value: unknown,
  errors: Errors,
): ReceiptTradeAccountRule[] | null {
  const path = "trade.accountRules";
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length > MAX_TRADE_ACCOUNT_RULES) {
    errors.add(path, "too_many");
    return null;
  }
  const before = errors.list.length;
  const out: ReceiptTradeAccountRule[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.add(entryPath, "invalid_type");
      return;
    }
    checkKeys(entry, TRADE_ACCOUNT_RULE_KEYS, `${entryPath}.`, errors);
    // An account rule matches the account text the email printed, one text.
    const matchOk = checkPattern(
      entry.match,
      `${entryPath}.match`,
      NO_CAPTURES,
      errors,
      false,
    );
    const accountId = checkUuid(
      entry.accountId,
      `${entryPath}.accountId`,
      errors,
    );
    const currency =
      entry.currency === undefined
        ? undefined
        : checkCurrencyCode(entry.currency, `${entryPath}.currency`, errors);
    if (matchOk && accountId !== null && currency !== null) {
      out.push({
        match: entry.match as string,
        accountId,
        ...(currency !== undefined ? { currency } : {}),
      });
    }
  });
  return errors.list.length === before ? out : null;
}

function checkCurrencyCode(
  value: unknown,
  path: string,
  errors: Errors,
): string | null {
  if (typeof value !== "string") {
    errors.add(path, "invalid_type");
    return null;
  }
  if (!CURRENCY_CODE.test(value)) {
    errors.add(path, "invalid_currency");
    return null;
  }
  return value;
}

function checkTradeCurrencyMarkers(
  value: unknown,
  errors: Errors,
): ReceiptTradeCurrencyMarker[] | null {
  const path = "trade.currencyMarkers";
  if (!Array.isArray(value)) {
    errors.add(path, "invalid_type");
    return null;
  }
  if (value.length > MAX_TRADE_CURRENCY_MARKERS) {
    errors.add(path, "too_many");
    return null;
  }
  const before = errors.list.length;
  const out: ReceiptTradeCurrencyMarker[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.add(entryPath, "invalid_type");
      return;
    }
    checkKeys(entry, TRADE_CURRENCY_MARKER_KEYS, `${entryPath}.`, errors);
    const matchOk = checkPattern(
      entry.match,
      `${entryPath}.match`,
      NO_CAPTURES,
      errors,
    );
    const currency = checkCurrencyCode(
      entry.currency,
      `${entryPath}.currency`,
      errors,
    );
    if (matchOk && currency !== null) {
      out.push({ match: entry.match as string, currency });
    }
  });
  return errors.list.length === before ? out : null;
}

/**
 * The `trade` section: `action` and `symbol` are required lists, at least one
 * of `total` and `price` must be present, and the account must be decidable:
 * `defaultAccountId`, or `account` entries with `accountRules`. `quantity` is
 * optional because a cash dividend states none; a buy, a sell or a
 * reinvestment the profile reads without one is `trade_no_quantity`.
 */
function checkTrade(
  value: unknown,
  errors: Errors,
): ReceiptTradeDefinition | null {
  if (!isRecord(value)) {
    errors.add("trade", "invalid_type");
    return null;
  }
  const before = errors.list.length;
  checkKeys(value, TRADE_KEYS, "trade.", errors);
  const fields: [keyof ReceiptTradeDefinition, FieldCaptures, boolean][] = [
    ["action", captureOf("action"), true],
    ["symbol", captureOf("symbol"), true],
    ["quantity", captureOf("quantity"), false],
    ["total", AMOUNT_CAPTURES, false],
    ["price", AMOUNT_CAPTURES, false],
    ["commission", AMOUNT_CAPTURES, false],
    ["date", captureOf("date"), false],
    ["account", captureOf("account"), false],
  ];
  const out: Record<string, unknown> = {};
  for (const [field, captures, required] of fields) {
    if (value[field] === undefined) {
      if (required) errors.add(`trade.${field}`, "empty");
      continue;
    }
    const patterns = checkPatternList(
      value[field],
      `trade.${field}`,
      captures,
      errors,
      1,
    );
    if (patterns !== null) out[field] = patterns;
  }
  if (value.total === undefined && value.price === undefined) {
    errors.add("trade.total", "trade_amount_missing");
  }
  if (value.accountRules !== undefined) {
    const rules = checkTradeAccountRules(value.accountRules, errors);
    if (rules !== null) out.accountRules = rules;
  }
  if (value.currencyMarkers !== undefined) {
    const markers = checkTradeCurrencyMarkers(value.currencyMarkers, errors);
    if (markers !== null) out.currencyMarkers = markers;
  }
  if (value.defaultAccountId !== undefined) {
    const id = checkUuid(
      value.defaultAccountId,
      "trade.defaultAccountId",
      errors,
    );
    if (id !== null) out.defaultAccountId = id;
  }
  // Rules decide an account without `account` entries too: an email that
  // prints no account text is matched by a `*` rule (one per currency).
  const decidable =
    value.defaultAccountId !== undefined ||
    (Array.isArray(value.accountRules) && value.accountRules.length > 0);
  if (!decidable) errors.add("trade.defaultAccountId", "trade_account_missing");
  return errors.list.length === before
    ? (out as unknown as ReceiptTradeDefinition)
    : null;
}

/**
 * Validate an untrusted value as a receipt parser definition (version 2, the
 * only one). Refuses unknown keys at every level, wrong types, another
 * version (`unsupported_version`, version 1 included), bounds exceeded,
 * malformed or repeated captures, a capture name the field does not take, and
 * a category id that is not a UUID. On success the returned definition is a
 * fresh object holding only validated data.
 */
export function validateReceiptParserDefinition(
  input: unknown,
): ReceiptParserValidation {
  const errors = new Errors();
  if (!isRecord(input)) {
    errors.add("", "not_object");
    return { ok: false, errors: errors.list };
  }
  checkKeys(input, TOP_LEVEL_KEYS, "", errors);
  if (input.version !== RECEIPT_PARSER_VERSION) {
    errors.add("version", "unsupported_version");
  }

  const out: Record<string, unknown> = { version: RECEIPT_PARSER_VERSION };
  if (input.source !== undefined) {
    // Anything that is not one of the two sources is the same refusal, whatever its type.
    if (RECEIPT_LINES_SOURCES.includes(input.source as ReceiptLinesSource)) {
      out.source = input.source;
    } else {
      errors.add("source", "invalid_value");
    }
  }
  let role: ReceiptParserRole | undefined;
  if (input.role !== undefined) {
    if (RECEIPT_PARSER_ROLES.includes(input.role as ReceiptParserRole)) {
      role = input.role as ReceiptParserRole;
      out.role = role;
    } else {
      errors.add("role", "role_invalid");
    }
  }
  const fields: [
    (
      | "orderId"
      | "total"
      | "paid"
      | "shipping"
      | "fees"
      | "discount"
      | "payee"
      | "reference"
    ),
    FieldCaptures,
  ][] = [
    ["orderId", ORDER_ID_CAPTURES],
    ["total", AMOUNT_CAPTURES],
    ["paid", AMOUNT_CAPTURES],
    ["shipping", AMOUNT_CAPTURES],
    ["fees", AMOUNT_CAPTURES],
    ["discount", AMOUNT_CAPTURES],
    ["payee", PAYEE_CAPTURES],
    ["reference", REFERENCE_CAPTURES],
  ];
  for (const [field, captures] of fields) {
    if (input[field] === undefined) continue;
    const patterns = checkPatternList(input[field], field, captures, errors, 0);
    if (patterns !== null) out[field] = patterns;
  }
  if (input.linkKey !== undefined) {
    if (role !== "component")
      errors.add("linkKey", "link_key_requires_component");
    const patterns = checkPatternList(
      input.linkKey,
      "linkKey",
      captureOf("link"),
      errors,
      0,
    );
    if (patterns !== null) out.linkKey = patterns;
  }
  if (
    role === "component" &&
    (input.linkKey === undefined ||
      (Array.isArray(input.linkKey) && input.linkKey.length === 0))
  ) {
    errors.add("linkKey", "link_key_missing");
  }
  if (input.link !== undefined) {
    if (role !== "settlement") errors.add("link", "link_requires_settlement");
    const link = checkLink(input.link, errors);
    if (link !== null) out.link = link;
  }
  if (input.discard !== undefined) {
    // Anything that is not one of the two modes is the same refusal, whatever its type.
    if (RECEIPT_DISCARD_MODES.includes(input.discard as ReceiptDiscardMode)) {
      out.discard = input.discard;
    } else {
      errors.add("discard", "invalid_value");
    }
  }
  if (input.match !== undefined) {
    const match = checkMatch(
      input.match,
      Array.isArray(input.reference) && input.reference.length > 0,
      errors,
    );
    if (match !== null) out.match = match;
  }
  if (input.tag !== undefined) {
    const tag = checkTag(input.tag, errors);
    if (tag !== null) out.tag = tag;
  }
  if (input.aiCategories !== undefined) {
    if (typeof input.aiCategories === "boolean") {
      out.aiCategories = input.aiCategories;
    } else {
      errors.add("aiCategories", "invalid_type");
    }
  }
  if (input.trade !== undefined) {
    const trade = checkTrade(input.trade, errors);
    if (trade !== null) out.trade = trade;
    // A trade profile reads a brokerage confirmation, nothing else.
    if (role !== undefined && role !== "standalone") {
      errors.add("role", "role_trade_conflict");
    }
    for (const key of Object.keys(input)) {
      if (
        TOP_LEVEL_KEYS.includes(key) &&
        !TRADE_COMPATIBLE_KEYS.includes(key)
      ) {
        errors.add(key, "trade_conflict");
      }
    }
  }
  if (input.items !== undefined) {
    const items = checkItems(input.items, role === "settlement", errors);
    if (items !== null) out.items = items;
  }
  if (input.categoryRules !== undefined) {
    const rules = checkCategoryRules(input.categoryRules, errors);
    if (rules !== null) out.categoryRules = rules;
  }
  for (const field of ["requireLine", "skipIfLine", "waitIfLine"] as const) {
    if (input[field] === undefined) continue;
    const globs = checkGlobList(input[field], field, MAX_LINE_GUARDS, errors);
    if (globs !== null) out[field] = globs;
  }
  for (const field of [
    "defaultCategoryId",
    "shippingCategoryId",
    "feesCategoryId",
  ] as const) {
    if (input[field] === undefined) continue;
    const id = checkUuid(input[field], field, errors);
    if (id !== null) out[field] = id;
  }
  for (const field of [
    "defaultCategory",
    "shippingCategory",
    "feesCategory",
  ] as const) {
    if (input[field] === undefined) continue;
    const name = checkCategoryName(input[field], field, errors);
    if (name !== null) out[field] = name;
  }
  if (input.balanceTolerance !== undefined) {
    const text = checkBalanceTolerance(input.balanceTolerance, errors);
    if (text !== null) out.balanceTolerance = text;
  }

  return errors.list.length > 0
    ? { ok: false, errors: errors.list }
    : { ok: true, definition: out as unknown as ReceiptParserDefinition };
}

/**
 * Every account id a `trade` section refers to, each once (the rules, then the
 * default). The proposal checks each is the user's INVESTMENT account when it
 * builds the card, so a foreign id fails there and nowhere writes a row.
 */
export function collectParserAccountIds(
  definition: ReceiptParserDefinition,
): string[] {
  const trade = definition.trade;
  if (!trade) return [];
  const ids = (trade.accountRules ?? []).map((rule) => rule.accountId);
  if (trade.defaultAccountId) ids.push(trade.defaultAccountId);
  return [...new Set(ids)];
}

/**
 * Every category id a definition refers to, each once, in first-seen order
 * (rules, then the default, then shipping). The service that saves a parser
 * checks in the write's transaction that the user owns each of them.
 */
export function collectParserCategoryIds(
  definition: ReceiptParserDefinition,
): string[] {
  const ids: string[] = [];
  for (const rule of definition.categoryRules ?? []) ids.push(rule.categoryId);
  if (definition.defaultCategoryId) ids.push(definition.defaultCategoryId);
  if (definition.shippingCategoryId) ids.push(definition.shippingCategoryId);
  if (definition.feesCategoryId) ids.push(definition.feesCategoryId);
  return [...new Set(ids)];
}
