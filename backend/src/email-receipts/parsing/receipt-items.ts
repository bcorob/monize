import type { GlobCaptures } from "../../transaction-rules/rule-glob-capture";
import {
  isStrictReceiptAmount,
  parseReceiptAmount,
  parseReceiptQty,
} from "./receipt-amount";
import { matchReceiptLines, matchReceiptPattern } from "./receipt-glob";
import { normalizeInstalmentText, normalizeLinkValue } from "./receipt-link";
import { itemSectionRange, traceLines } from "./receipt-lines";
import {
  MAX_ITEMS,
  MAX_JOINED_LINES,
  ReceiptBlockItemsDefinition,
  ReceiptItemsDefinition,
  ReceiptParserDefinition,
  ReceiptRecordStep,
  ReceiptSingleItemsDefinition,
  ReceiptTraceItem,
} from "./receipt-parser.types";

/** The line items of an email (design 5.1): one per line, a multi-line record, or one for the whole email. */

// ----------------------------------------------------------------- items

/** Name, qty and line total in units from the captures of an item; the amount is null when none was captured. */
interface ItemFields {
  name: string;
  qty: number;
  amount: number | null;
  /** A settlement part's normalized link value and instalment text; absent when not captured or unusable. */
  link?: string;
  instalment?: string;
}

/** The `link` and `instalment` keys of an item, only those the captures hold a usable value for. */
function linkFields(
  captures: GlobCaptures,
): Pick<ItemFields, "link" | "instalment"> {
  const link = normalizeLinkValue(captures.link ?? "");
  const instalment = normalizeInstalmentText(captures.instalment ?? "");
  return {
    ...(link === null ? {} : { link }),
    ...(instalment === null ? {} : { instalment }),
  };
}

/**
 * Name and qty from the captures of an item pattern or record, and the line
 * total: the `amount` capture, else the unit `price` times qty, else null (the
 * item then takes the email's total if it is the only item). Null when the
 * captures do not read at all.
 */
function readItemFields(captures: GlobCaptures): ItemFields | null {
  const name = captures.name?.trim() ?? "";
  if (name === "") return null;
  const qty = captures.qty === undefined ? 1 : parseReceiptQty(captures.qty);
  if (qty === null) return null;
  const money = captures.amount ?? captures.price;
  const extra = linkFields(captures);
  if (money === undefined) return { name, qty, amount: null, ...extra };
  const units = parseReceiptAmount(money);
  if (units === null || !isStrictReceiptAmount(money)) return null;
  const amount = captures.amount === undefined ? units * qty : units;
  return Number.isSafeInteger(amount) ? { name, qty, amount, ...extra } : null;
}

/** What an item looks like before its category is known. */
export interface RawItem extends ItemFields {
  trace: ReceiptTraceItem;
}

/** An item pattern's reading is usable only when it reads an item with an amount. */
const acceptItem = (captures: GlobCaptures): boolean => {
  const read = readItemFields(captures);
  return read !== null && read.amount !== null;
};

/** A joined text read by one one-line pattern, or null when neither reading of it is usable. */
function readTextItem(text: string, pattern: string): ItemFields | null {
  const captures = matchReceiptPattern(pattern, text, acceptItem);
  return captures === null ? null : readItemFields(captures);
}

/** The item one pattern reads at line `at` (a multi-line pattern over the lines from `at`, before `end`), with the lines it took. */
function readItemAt(
  pattern: string,
  lines: readonly string[],
  at: number,
  end: number,
): { item: ItemFields; span: number } | null {
  const found = matchReceiptLines(pattern, lines, at, acceptItem, end);
  if (found === null) return null;
  const item = readItemFields(found.captures);
  return item === null ? null : { item, span: found.span };
}

/**
 * One item per line: each line of the section is read by the first pattern
 * that reads it; a multi-line pattern reads the lines from there on and the
 * next item starts after the last of them. With `joinWrapped`, a line no
 * pattern reads is held (the last three) and put in front of the next line,
 * joined by a space, before the patterns are tried on that; an emitted item
 * clears what was held.
 */
function readPatternItems(
  items: ReceiptItemsDefinition,
  lines: readonly string[],
): RawItem[] {
  const { start, end } = itemSectionRange(
    lines,
    items.startAfter,
    items.stopAt,
  );
  const join = items.joinWrapped === true;
  const out: RawItem[] = [];
  let held: number[] = [];
  for (let at = start; at < end; at++) {
    const read = readJoinedLine(items.patterns, lines, held, at, end);
    if (read !== null) {
      out.push({
        ...read.item,
        trace: {
          mode: "patterns",
          patterns: [read.pattern],
          lines: [
            ...read.used.flatMap((index) => traceLines(lines, index, 1)),
            ...traceLines(lines, at, read.span),
          ],
        },
      });
      at += read.span - 1;
      held = [];
      if (out.length >= MAX_ITEMS) break;
    } else if (join) {
      held.push(at);
      if (held.length > MAX_JOINED_LINES) held.shift();
    }
  }
  return out;
}

/**
 * One line read by the first pattern that reads it. With held lines the whole
 * buffer is put in front of the line first; when that does not read, a shorter
 * buffer is tried (the last `n - 1` held lines, down to none), so a stray
 * unread line before a one-line item does not hide the item. A multi-line
 * pattern is tried only without held lines (its parts are lines of their own),
 * and `span` is the lines it took from `at` on (1 for a one-line pattern).
 */
function readJoinedLine(
  patterns: readonly string[],
  lines: readonly string[],
  held: readonly number[],
  at: number,
  end: number,
): {
  item: ItemFields;
  pattern: string;
  used: number[];
  span: number;
} | null {
  for (let keep = held.length; keep > 0; keep--) {
    const used = held.slice(held.length - keep);
    const text = `${used.map((index) => lines[index]).join(" ")} ${lines[at]}`;
    for (const pattern of patterns) {
      const item = readTextItem(text, pattern);
      if (item !== null) return { item, pattern, used, span: 1 };
    }
  }
  for (const pattern of patterns) {
    const read = readItemAt(pattern, lines, at, end);
    if (read !== null) return { ...read, pattern, used: [] };
  }
  return null;
}

/** A step's reading of a line is usable only when every value it captured reads. */
const acceptStep = (captures: GlobCaptures): boolean => {
  if (captures.name !== undefined && captures.name.trim() === "") return false;
  for (const money of [captures.amount, captures.price]) {
    if (money !== undefined && !isStrictReceiptAmount(money)) return false;
  }
  return captures.qty === undefined || parseReceiptQty(captures.qty) !== null;
};

/** The globs of a record step: its `line`, or its alternatives in order. */
const stepGlobs = (step: ReceiptRecordStep): readonly string[] =>
  typeof step.line === "string" ? [step.line] : step.line;

/**
 * Read one record at `start` of the section's lines: each step consumes the
 * line under the cursor (a multi-line glob: the lines from the cursor on) when
 * one of its globs matches and the values read (the alternatives in order, the
 * first that reads wins); an optional step that does not match consumes
 * nothing, a required one fails the record. The captures of all the steps are
 * one item (a capture name belongs to one step).
 */
function readRecord(
  record: readonly ReceiptRecordStep[],
  section: readonly number[],
  sectionLines: readonly string[],
  lines: readonly string[],
  start: number,
): { item: RawItem; next: number } | null {
  const merged: Record<string, string> = Object.create(null);
  const used: number[] = [];
  const patterns: string[] = [];
  let at = start;
  for (const step of record) {
    let taken: { glob: string; captures: GlobCaptures; span: number } | null =
      null;
    for (const glob of stepGlobs(step)) {
      const found = matchReceiptLines(glob, sectionLines, at, acceptStep);
      if (found !== null) {
        taken = { glob, ...found };
        break;
      }
    }
    if (taken === null) {
      if (step.optional === true) continue;
      return null;
    }
    for (const [name, value] of Object.entries(taken.captures)) {
      if (!(name in merged)) merged[name] = value;
    }
    for (let k = 0; k < taken.span; k++) {
      patterns.push(taken.glob);
      used.push(section[at + k]);
    }
    at += taken.span;
  }
  const fields = readItemFields(merged);
  if (fields === null) return null;
  return {
    item: {
      ...fields,
      trace: {
        mode: "record",
        patterns,
        lines: used.flatMap((index) => traceLines(lines, index, 1)),
      },
    },
    next: at,
  };
}

/**
 * Block items: the section minus its `skipLines` (a multi-line skip glob drops
 * every line it matched), then a record read from a cursor.
 */
function readBlockItems(
  items: ReceiptBlockItemsDefinition,
  lines: readonly string[],
): RawItem[] {
  const skip = items.skipLines ?? [];
  const { start, end } = itemSectionRange(
    lines,
    items.startAfter,
    items.stopAt,
  );
  const section: number[] = [];
  let at = start;
  while (at < end) {
    let dropped = 0;
    for (const glob of skip) {
      const found = matchReceiptLines(glob, lines, at, () => true, end);
      if (found !== null) {
        dropped = found.span;
        break;
      }
    }
    if (dropped === 0) section.push(at);
    at += Math.max(dropped, 1);
  }
  const sectionLines = section.map((index) => lines[index]);
  const out: RawItem[] = [];
  let cursor = 0;
  while (cursor < section.length && out.length < MAX_ITEMS) {
    const read = readRecord(items.record, section, sectionLines, lines, cursor);
    if (read === null) {
      // A failed record moves the cursor one line, so the next product is found.
      cursor += 1;
      continue;
    }
    out.push(read.item);
    cursor = Math.max(read.next, cursor + 1);
  }
  return out;
}

/** One item for the whole email: its name from the first section line (or run of lines, multi-line) the glob reads; its amount comes later. */
function readSingleItem(
  items: ReceiptSingleItemsDefinition,
  lines: readonly string[],
): RawItem[] {
  const { start, end } = itemSectionRange(
    lines,
    items.startAfter,
    items.stopAt,
  );
  const glob = items.single?.name;
  if (typeof glob !== "string") return [];
  for (let at = start; at < end; at++) {
    const found = matchReceiptLines(
      glob,
      lines,
      at,
      (c) => (c.name ?? "") !== "",
      end,
    );
    if (found !== null) {
      return [
        {
          name: found.captures.name,
          qty: 1,
          amount: null,
          trace: {
            mode: "single",
            patterns: [glob],
            lines: traceLines(lines, at, found.span),
          },
        },
      ];
    }
  }
  return [];
}

export function readItems(
  def: ReceiptParserDefinition,
  lines: readonly string[],
): RawItem[] {
  const items = def.items;
  if (!items) return [];
  if ("record" in items) return readBlockItems(items, lines);
  if ("single" in items) return readSingleItem(items, lines);
  return readPatternItems(items, lines);
}
