import type { GlobCaptures } from "../../transaction-rules/rule-glob-capture";
import { isStrictReceiptAmount, parseReceiptAmount } from "./receipt-amount";
import {
  capturePart,
  matchReceiptLines,
  matchReceiptPattern,
  type ReceiptLinesMatch,
} from "./receipt-glob";
import { readItems, type RawItem } from "./receipt-items";
import { normalizeLinkValue } from "./receipt-link";
import { parseToleranceUnits } from "./receipt-match-config";
import {
  normalizeLine,
  normalizeReceiptLines,
  traceLine,
  traceMatch,
  traceSubject,
} from "./receipt-lines";
import {
  DEFAULT_LABEL_WITHIN,
  MAX_BALANCE_TOLERANCE_UNITS,
  MAX_LABEL_WITHIN,
  MIN_LABEL_WITHIN,
  ParsedReceipt,
  ParsedReceiptItem,
  ParsedReceiptReason,
  ReceiptDiscardMode,
  ReceiptFieldEntry,
  ReceiptLabelledPattern,
  ReceiptParserDefinition,
  ReceiptTrace,
  ReceiptTraceHit,
} from "./receipt-parser.types";

/**
 * The receipt parser (design 5): one definition, the subject and the text of
 * one email in, what the email says out. Pure: no database, no clock, no
 * regular expression over email text (every pattern is a rule glob matched
 * against one line at a time; a multi-line pattern, parts joined by `\n`,
 * matches its parts against consecutive lines), and integer arithmetic only
 * (amounts are 1/10000 units).
 *
 * - PRIORITY BY ORDER: a field's entries are tried in array order, each over
 *   the whole email, so `total: [specific, general]` prefers the specific one
 *   wherever it sits.
 * - LABELLED FIELDS: `{label, value, within}` finds a line matching `label`
 *   and reads the value from one of the next `within` lines, for emails that
 *   put "TOTAL" on one line and the amount under it.
 * - ITEMS: one per line (`patterns`, optionally `joinWrapped`), a multi-line
 *   `record` read from a cursor, or one `single` item for the whole email.
 *
 * An amount is `isStrictReceiptAmount`: a line such as "3 × 1,47 zł" is not
 * read as 31,47. Every read also leaves a trace (which entry, which line) for
 * the `test` operation.
 */
export { normalizeReceiptLines } from "./receipt-lines";

// ---------------------------------------------------------------- fields

const isLabelled = (entry: unknown): entry is ReceiptLabelledPattern =>
  typeof entry === "object" &&
  entry !== null &&
  typeof (entry as ReceiptLabelledPattern).label === "string" &&
  typeof (entry as ReceiptLabelledPattern).value === "string";

/** The `within` of a labelled entry: an integer from 1 to 10, else the default of 3. */
function lookahead(entry: ReceiptLabelledPattern): number {
  const within = entry.within;
  return typeof within === "number" &&
    Number.isInteger(within) &&
    within >= MIN_LABEL_WITHIN &&
    within <= MAX_LABEL_WITHIN
    ? within
    : DEFAULT_LABEL_WITHIN;
}

/**
 * What an entry read: the captures, the line they came from (the first, for a
 * multi-line pattern) and how many lines the pattern took and, for a labelled
 * entry, its label line.
 */
interface Found {
  captures: GlobCaptures;
  line: number;
  span: number;
  labelLine?: number;
}

/**
 * A labelled entry: for each line matching `label`, the first of the next
 * `within` lines (counted from the label's last line) whose `value` matches
 * and is accepted; none, then the next line matching the label. A line's
 * reading by `value` is cached, so however many label lines look at it, each
 * line is matched once.
 */
function findLabelled(
  entry: ReceiptLabelledPattern,
  lines: readonly string[],
  accept: (captures: GlobCaptures) => boolean,
): Found | null {
  const within = lookahead(entry);
  const read = new Map<number, ReceiptLinesMatch | null>();
  for (let at = 0; at < lines.length; at++) {
    const label = matchReceiptLines(entry.label, lines, at, () => true);
    if (label === null) continue;
    const labelEnd = at + label.span - 1;
    const last = Math.min(lines.length - 1, labelEnd + within);
    for (let next = labelEnd + 1; next <= last; next++) {
      let value = read.get(next);
      if (value === undefined) {
        value = matchReceiptLines(entry.value, lines, next, accept);
        read.set(next, value);
      }
      if (value !== null) {
        return {
          captures: value.captures,
          line: next,
          span: value.span,
          labelLine: at,
        };
      }
    }
  }
  return null;
}

/** One entry over the whole email: a line pattern's first accepted line, or a labelled entry. */
function findEntry(
  entry: ReceiptFieldEntry,
  lines: readonly string[],
  accept: (captures: GlobCaptures) => boolean,
): Found | null {
  if (typeof entry === "string") {
    for (let i = 0; i < lines.length; i++) {
      const found = matchReceiptLines(entry, lines, i, accept);
      if (found !== null) return { ...found, line: i };
    }
    return null;
  }
  return isLabelled(entry) ? findLabelled(entry, lines, accept) : null;
}

function hitOf(
  entry: ReceiptFieldEntry,
  index: number,
  found: Found,
  lines: readonly string[],
): ReceiptTraceHit {
  if (typeof entry === "string") {
    return {
      entry: index,
      pattern: entry,
      ...traceMatch(lines, found.line, found.span),
    };
  }
  return {
    entry: index,
    pattern: entry.value,
    label: entry.label,
    ...(found.labelLine === undefined
      ? {}
      : { labelLine: traceLine(lines, found.labelLine) }),
    ...traceMatch(lines, found.line, found.span),
  };
}

/** The first entry, in array order, that reads something, with what read it. */
export function findField(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
  accept: (captures: GlobCaptures) => boolean,
): { captures: GlobCaptures; hit: ReceiptTraceHit } | null {
  if (!Array.isArray(entries)) return null;
  for (let index = 0; index < entries.length; index++) {
    const found = findEntry(entries[index], lines, accept);
    if (found !== null) {
      return {
        captures: found.captures,
        hit: hitOf(entries[index], index, found, lines),
      };
    }
  }
  return null;
}

const hasStrictAmount = (captures: GlobCaptures): boolean =>
  captures.amount !== undefined && isStrictReceiptAmount(captures.amount);

const hasOrderId = (captures: GlobCaptures): boolean =>
  identifierToken(captures, "orderid") !== "";

const hasReference = (captures: GlobCaptures): boolean =>
  identifierToken(captures, "reference") !== "";

const hasLink = (captures: GlobCaptures): boolean =>
  identifierToken(captures, "link") !== "";

const hasPayee = (captures: GlobCaptures): boolean =>
  (captures.payee ?? "") !== "";

/**
 * An order number or a bank reference has no spaces: only the first
 * whitespace-delimited token of the capture is kept. A link value may hold
 * spaces ("1000 000 002"): the whole capture is kept, normalized (empty when
 * the capture holds no usable link value).
 */
const identifierToken = (
  captures: GlobCaptures,
  name: "orderid" | "reference" | "link",
): string =>
  name === "link"
    ? (normalizeLinkValue(captures.link ?? "") ?? "")
    : (captures[name]?.trim().split(/\s+/)[0] ?? "");

interface Read<T> {
  value: T;
  hit: ReceiptTraceHit;
}

export function readAmount(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
): Read<number> | null {
  const found = findField(entries, lines, hasStrictAmount);
  if (found === null) return null;
  const value = parseReceiptAmount(found.captures.amount);
  return value === null ? null : { value, hit: found.hit };
}

/**
 * Every fee: each entry, in order, over the whole email, contributes the first
 * amount it accepts (an entry that finds none adds nothing). Unlike the other
 * fields the entries are not alternatives: a deposit and a packing charge are
 * two entries and two fees. A fee whose amount is on a line another entry
 * already read an amount from is the same fee and is counted once (for a
 * multi-line pattern, the line its `{amount}` part matched).
 */
function readFees(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
): Read<number>[] {
  if (!Array.isArray(entries)) return [];
  const out: Read<number>[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const found = findEntry(entry, lines, hasStrictAmount);
    if (found === null) continue;
    const pattern = typeof entry === "string" ? entry : entry.value;
    const amountLine = found.line + capturePart(pattern, "amount");
    if (seen.has(amountLine)) continue;
    const value = parseReceiptAmount(found.captures.amount);
    if (value === null) continue;
    seen.add(amountLine);
    out.push({ value, hit: hitOf(entries[index], index, found, lines) });
  }
  return out;
}

function readPayee(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
): Read<string> | null {
  const found = findField(entries, lines, hasPayee);
  return found === null
    ? null
    : { value: found.captures.payee, hit: found.hit };
}

/**
 * The first entry, in array order, that finds an identifier (an order id or a
 * bank reference: the same rules for both). A line pattern reads the subject
 * first, then each line; a labelled entry and a multi-line pattern read lines
 * only (a subject is one line, with nothing near it).
 */
function readIdentifier(
  entries: readonly ReceiptFieldEntry[] | undefined,
  subject: string,
  lines: readonly string[],
  capture: "orderid" | "reference" | "link",
): Read<string> | null {
  if (!Array.isArray(entries)) return null;
  const accept =
    capture === "orderid"
      ? hasOrderId
      : capture === "link"
        ? hasLink
        : hasReference;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry === "string") {
      const fromSubject = matchReceiptPattern(entry, subject, accept);
      if (fromSubject !== null) {
        return {
          value: identifierToken(fromSubject, capture),
          hit: { entry: index, pattern: entry, line: traceSubject(subject) },
        };
      }
    }
    const found = findEntry(entry, lines, accept);
    if (found !== null) {
      return {
        value: identifierToken(found.captures, capture),
        hit: hitOf(entry, index, found, lines),
      };
    }
  }
  return null;
}

/** The first glob (in list order) matching some line: for `requireLine`, `skipIfLine` and `waitIfLine`. */
function findGuard(
  globs: readonly string[] | undefined,
  lines: readonly string[],
): ReceiptTraceHit | null {
  if (!Array.isArray(globs)) return null;
  for (let entry = 0; entry < globs.length; entry++) {
    for (let i = 0; i < lines.length; i++) {
      const found = matchReceiptLines(globs[entry], lines, i, () => true);
      if (found !== null) {
        return {
          entry,
          pattern: globs[entry],
          ...traceMatch(lines, i, found.span),
        };
      }
    }
  }
  return null;
}

/** What `requireLine`, `skipIfLine` and `waitIfLine` found in an email. */
export interface ReceiptLineGuards {
  /** False when the definition has `requireLine` and no line matches one of its globs. */
  applies: boolean;
  requireLine: ReceiptTraceHit | null;
  skipIfLine: ReceiptTraceHit | null;
  waitIfLine: ReceiptTraceHit | null;
}

export function readLineGuards(
  def: ReceiptParserDefinition,
  lines: readonly string[],
): ReceiptLineGuards {
  const requireLine = findGuard(def.requireLine, lines);
  return {
    applies:
      !Array.isArray(def.requireLine) ||
      def.requireLine.length === 0 ||
      requireLine !== null,
    requireLine,
    skipIfLine: findGuard(def.skipIfLine, lines),
    waitIfLine: findGuard(def.waitIfLine, lines),
  };
}

/**
 * What the pipeline would do with an email under a parser: `read` it, or pass
 * over / set aside / hold it by a guard, ignore or delete it because the
 * profile discards its emails (`discard_ignore`, `discard_delete`), or fail it
 * because the parser reads the HTML part (`source: "html"`) and the email has
 * none (`no_html`).
 */
export type ReceiptOutcome =
  | "read"
  | "not_applicable"
  | "skip_line"
  | "wait_line"
  | "discard_ignore"
  | "discard_delete"
  | "no_html";

/**
 * `requireLine` unmet: another parser would be tried; else the profile's
 * `discard`, then `skipIfLine`, then `waitIfLine`, else the email is read.
 */
export function receiptOutcome(
  guards: ReceiptLineGuards,
  discard?: ReceiptDiscardMode,
): ReceiptOutcome {
  if (!guards.applies) return "not_applicable";
  if (discard !== undefined) return `discard_${discard}`;
  if (guards.skipIfLine !== null) return "skip_line";
  if (guards.waitIfLine !== null) return "wait_line";
  return "read";
}

// ------------------------------------------------------------ categories

interface CategoryContext {
  payee: string | null;
  lines: readonly string[];
  /** Whether some line matches rule `i` (computed once per rule, for the "line" field). */
  lineMatches: Map<number, boolean>;
}

const matchesGlob = (glob: string, text: string): boolean =>
  matchReceiptPattern(glob, text, () => true) !== null;

/** Whether some run of lines matches a glob (a multi-line one spans several). */
const anyLineMatches = (glob: string, lines: readonly string[]): boolean =>
  lines.some(
    (_, at) => matchReceiptLines(glob, lines, at, () => true) !== null,
  );

/**
 * The category of an item: the first rule, in order, that covers it (its name
 * matches a `field: "item"` rule; the parsed payee matches a `payee` rule; any
 * line matches a `line` rule), else the default, else the payee's default, else
 * none.
 */
function itemCategory(
  def: ReceiptParserDefinition,
  name: string,
  fallbackCategoryId: string | null,
  ctx: CategoryContext,
): string | null {
  const rules = def.categoryRules ?? [];
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    const field = rule.field ?? "item";
    let covers: boolean;
    if (field === "payee") {
      covers = ctx.payee !== null && matchesGlob(rule.match, ctx.payee);
    } else if (field === "line") {
      let known = ctx.lineMatches.get(index);
      if (known === undefined) {
        known = anyLineMatches(rule.match, ctx.lines);
        ctx.lineMatches.set(index, known);
      }
      covers = known;
    } else {
      covers = matchesGlob(rule.match, name);
    }
    if (covers) return rule.categoryId;
  }
  return def.defaultCategoryId ?? fallbackCategoryId;
}

// ---------------------------------------------------------- completeness

/**
 * The first thing missing, in the order of the spec's completeness table
 * (section 4); null when the receipt is complete. The one truth table: a
 * receipt read by the AI is judged by this function too.
 *
 * `gross` is the items plus shipping plus the fees and `net` is `gross` minus
 * the discount (a missing discount is 0). One of `total` and `paid` must be
 * stated; `paid`, when stated, equals `net`; `total`, when stated, equals
 * `gross` or `net`; "equals" is within `balanceTolerance` (absent: exactly).
 * A fee above 0 needs `feesCategoryId` (`items_uncategorized`, as a discount).
 * `itemsUnresolved` is true when an item has no amount and cannot take the
 * email's total.
 */
export function completeness(
  parsed: Omit<ParsedReceipt, "complete" | "reason" | "source">,
  itemsUnresolved = false,
): ParsedReceiptReason | null {
  const { total, items, shipping, discount } = parsed;
  const fees = parsed.fees ?? [];
  const tolerance = parsed.balanceTolerance ?? 0;
  const paid = parsed.paid ?? null;
  if (total === null && paid === null) return "no_total";
  if (itemsUnresolved) return "item_amount_missing";
  if (items.length === 0) return "no_items";
  // A `discount`-kind line (a joined component's discount) is subtracted like `discount`.
  const discountLines = items.reduce(
    (sum, item) => sum + (item.kind === "discount" ? item.amount : 0),
    0,
  );
  const gross =
    items.reduce(
      (sum, item) => sum + (item.kind === "discount" ? 0 : item.amount),
      0,
    ) +
    (shipping ?? 0) +
    fees.reduce((sum, fee) => sum + fee, 0);
  const net = gross - (discount ?? 0) - discountLines;
  const within = (stated: number, computed: number): boolean =>
    Math.abs(stated - computed) <= tolerance;
  if (
    net < 0 ||
    (paid !== null && !within(paid, net)) ||
    (total !== null && !within(total, gross) && !within(total, net))
  ) {
    return "items_unbalanced";
  }
  const discountUncategorized =
    (discount ?? 0) > 0 && parsed.discountCategoryId === null;
  const feesUncategorized =
    fees.some((fee) => fee > 0) && (parsed.feesCategoryId ?? null) === null;
  if (
    items.some((item) => item.categoryId === null) ||
    discountUncategorized ||
    feesUncategorized
  ) {
    return "items_uncategorized";
  }
  if ((shipping ?? 0) > 0 && parsed.shippingCategoryId === null) {
    return "shipping_uncategorized";
  }
  return null;
}

// ---------------------------------------------------------------- reading

/** The profile's `balanceTolerance` in 1/10000 units, bounded; 0 when absent or malformed. */
function balanceToleranceUnits(def: ReceiptParserDefinition): number {
  const units = parseToleranceUnits(def.balanceTolerance);
  return units === null ? 0 : Math.min(units, MAX_BALANCE_TOLERANCE_UNITS);
}

export interface TracedReceipt {
  parsed: ParsedReceipt;
  trace: ReceiptTrace;
  /** What the pipeline would do with this email: read it, or pass over / set aside / hold it by a guard. */
  outcome: ReceiptOutcome;
}

/**
 * Read one email, given as the lines of the source the definition names
 * (`def.source`: the text, or the HTML part; `pipeline/receipt-source-lines.ts`
 * chooses them), with a parser definition and say what read each value.
 * `lines` is null when the definition reads the HTML part and the email has
 * none: nothing is read and the outcome is `no_html`.
 * `fallbackCategoryId` is the parser payee's default category, used for an
 * item no rule categorises and no `defaultCategoryId` covers.
 *
 * The shipping line is categorised by `shippingCategoryId` alone, the discount
 * line by `defaultCategoryId` (else the fallback): a parser must say where
 * shipping goes before the receipt counts as complete.
 */
export function parseReceiptLinesTraced(
  def: ReceiptParserDefinition,
  subject: string,
  sourceLines: readonly string[] | null,
  fallbackCategoryId: string | null,
): TracedReceipt {
  const lines = sourceLines ?? [];
  const subjectLine = typeof subject === "string" ? normalizeLine(subject) : "";
  const orderId = readIdentifier(def.orderId, subjectLine, lines, "orderid");
  const reference = readIdentifier(
    def.reference,
    subjectLine,
    lines,
    "reference",
  );
  // Only a component reads a link key; any other receipt leaves the key absent.
  const component = def.role === "component";
  const linkKey = component
    ? readIdentifier(def.linkKey, subjectLine, lines, "link")
    : null;
  const total = readAmount(def.total, lines);
  const paid = readAmount(def.paid, lines);
  const shipping = readAmount(def.shipping, lines);
  const fees = readFees(def.fees, lines);
  const discount = readAmount(def.discount, lines);
  const payee = readPayee(def.payee, lines);
  const guards = readLineGuards(def, lines);

  // An item with no amount of its own takes the email's total (else what was
  // paid), but only when it is the only item; any other is unresolved.
  const raw = readItems(def, lines);
  const wholeAmount = total?.value ?? paid?.value ?? null;
  const resolved = raw.map((item) =>
    item.amount === null && raw.length === 1 && wholeAmount !== null
      ? { ...item, amount: wholeAmount }
      : item,
  );
  const kept = resolved.filter(
    (item): item is RawItem & { amount: number } => item.amount !== null,
  );
  const itemsUnresolved = kept.length !== resolved.length;

  const ctx: CategoryContext = {
    payee: payee?.value ?? null,
    lines,
    lineMatches: new Map(),
  };
  const items: ParsedReceiptItem[] = kept.map((item) => ({
    name: item.name,
    qty: item.qty,
    amount: item.amount,
    categoryId: itemCategory(def, item.name, fallbackCategoryId, ctx),
    ...(item.link === undefined ? {} : { link: item.link }),
    ...(item.instalment === undefined ? {} : { instalment: item.instalment }),
  }));
  const parsed = {
    orderId: orderId?.value ?? null,
    reference: reference?.value ?? null,
    ...(component ? { linkKey: linkKey?.value ?? null } : {}),
    total: total?.value ?? null,
    paid: paid?.value ?? null,
    payee: payee?.value ?? null,
    shipping: shipping?.value ?? null,
    ...(fees.length > 0 ? { fees: fees.map((fee) => fee.value) } : {}),
    discount: discount?.value ?? null,
    items,
    shippingCategoryId: def.shippingCategoryId ?? null,
    ...(def.feesCategoryId === undefined
      ? {}
      : { feesCategoryId: def.feesCategoryId }),
    ...(balanceToleranceUnits(def) > 0
      ? { balanceTolerance: balanceToleranceUnits(def) }
      : {}),
    discountCategoryId: def.defaultCategoryId ?? fallbackCategoryId,
  };
  const reason = completeness(parsed, itemsUnresolved);
  const trace: ReceiptTrace = {
    orderId: orderId?.hit ?? null,
    reference: reference?.hit ?? null,
    ...(component ? { linkKey: linkKey?.hit ?? null } : {}),
    total: total?.hit ?? null,
    paid: paid?.hit ?? null,
    shipping: shipping?.hit ?? null,
    ...(fees.length > 0 ? { fees: fees.map((fee) => fee.hit) } : {}),
    discount: discount?.hit ?? null,
    payee: payee?.hit ?? null,
    requireLine: guards.requireLine,
    skipIfLine: guards.skipIfLine,
    waitIfLine: guards.waitIfLine,
    items: kept.map((item) => item.trace),
  };
  return {
    parsed: { ...parsed, complete: reason === null, reason },
    trace,
    outcome:
      sourceLines === null ? "no_html" : receiptOutcome(guards, def.discard),
  };
}

/**
 * Read an email's TEXT with a definition, whatever `def.source` says: the
 * text-source reading, kept for the callers (and specs) that hold only a text.
 * The pipeline, the `test` operation and the AI tool choose the lines by the
 * definition's source and call `parseReceiptLinesTraced`.
 */
export function parseReceiptTraced(
  def: ReceiptParserDefinition,
  subject: string,
  bodyText: string,
  fallbackCategoryId: string | null,
): TracedReceipt {
  return parseReceiptLinesTraced(
    def,
    subject,
    normalizeReceiptLines(bodyText),
    fallbackCategoryId,
  );
}

/** Read one email's text with a parser definition (see `parseReceiptTraced`). */
export function parseReceipt(
  def: ReceiptParserDefinition,
  subject: string,
  bodyText: string,
  fallbackCategoryId: string | null,
): ParsedReceipt {
  return parseReceiptTraced(def, subject, bodyText, fallbackCategoryId).parsed;
}

/** Read one email, given as the lines of the definition's source, without the trace (see `parseReceiptLinesTraced`). */
export function parseReceiptLines(
  def: ReceiptParserDefinition,
  subject: string,
  sourceLines: readonly string[] | null,
  fallbackCategoryId: string | null,
): ParsedReceipt {
  return parseReceiptLinesTraced(def, subject, sourceLines, fallbackCategoryId)
    .parsed;
}
