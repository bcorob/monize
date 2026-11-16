import {
  MAX_LINE_LENGTH,
  MAX_PARSE_LINES,
  MAX_TRACE_LINE_LENGTH,
  type ReceiptTraceLine,
} from "./receipt-parser.types";

/**
 * The lines a parser reads (design 5.1): the email's text split, folded and
 * bounded, and the item section cut out of them. Pure.
 */

/**
 * Characters a mail client or a marketer adds that show nothing: the soft
 * hyphen, the combining grapheme joiner, zero-width spaces and joiners, the
 * bidirectional marks and embeddings (Amazon puts a right-to-left embedding
 * before an order number), the invisible operators and the byte order mark.
 * Dropped, so a number or a name is read as it looks.
 */
const INVISIBLE =
  /\u034F|[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Invisible characters dropped and every whitespace run (NBSP included) folded to one space; not trimmed, not cut. */
export function foldWhitespace(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ");
}

/** Invisible characters dropped, whitespace (NBSP included) folded to one space; trimmed; cut to the line bound. */
export function normalizeLine(line: string): string {
  const folded = foldWhitespace(line).trim();
  return folded.length > MAX_LINE_LENGTH
    ? folded.slice(0, MAX_LINE_LENGTH).trimEnd()
    : folded;
}

/**
 * Split the text of an email into the lines a parser reads: split on line
 * breaks, runs of whitespace (non-breaking spaces included) collapsed to one
 * space, trimmed, empty lines dropped, each line cut to 500 characters and at
 * most 2,000 lines kept.
 */
export function normalizeReceiptLines(text: string): string[] {
  if (typeof text !== "string") return [];
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (line === "") continue;
    lines.push(line);
    if (lines.length >= MAX_PARSE_LINES) break;
  }
  return lines;
}

/**
 * The `[start, end)` range of lines between `startAfter` and `stopAt` (both
 * optional, case-insensitive substrings): items start on the line after the
 * first line holding `startAfter` and end before the first line after the
 * start holding `stopAt`. A start marker that never appears leaves no section:
 * reading from the top instead would take the header and the totals for items.
 */
export function itemSectionRange(
  lines: readonly string[],
  startAfter: string | undefined,
  stopAt: string | undefined,
): { start: number; end: number } {
  let start = 0;
  if (startAfter !== undefined) {
    const marker = startAfter.toLowerCase();
    const at = lines.findIndex((line) => line.toLowerCase().includes(marker));
    if (at === -1) return { start: 0, end: 0 };
    start = at + 1;
  }
  let end = lines.length;
  if (stopAt !== undefined) {
    const marker = stopAt.toLowerCase();
    for (let i = start; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(marker)) {
        end = i;
        break;
      }
    }
  }
  return { start, end: Math.max(start, end) };
}

/** A traced line: its 1-based number and its text cut to 200 characters. */
export function traceLine(
  lines: readonly string[],
  index: number,
): ReceiptTraceLine {
  const text = lines[index] ?? "";
  return {
    line: index + 1,
    text:
      text.length > MAX_TRACE_LINE_LENGTH
        ? text.slice(0, MAX_TRACE_LINE_LENGTH)
        : text,
  };
}

/** The `span` lines from line `at` on, traced. */
export function traceLines(
  lines: readonly string[],
  at: number,
  span: number,
): ReceiptTraceLine[] {
  return Array.from({ length: span }, (_, k) => traceLine(lines, at + k));
}

/**
 * The trace of a match at line `at` that took `span` lines: its first line,
 * and every line it took when that is more than one (a multi-line pattern).
 */
export function traceMatch(
  lines: readonly string[],
  at: number,
  span: number,
): { line: ReceiptTraceLine; lines?: ReceiptTraceLine[] } {
  const line = traceLine(lines, at);
  return span <= 1 ? { line } : { line, lines: traceLines(lines, at, span) };
}

/** The subject as a traced line (line 0). */
export function traceSubject(subject: string): ReceiptTraceLine {
  return {
    line: 0,
    text:
      subject.length > MAX_TRACE_LINE_LENGTH
        ? subject.slice(0, MAX_TRACE_LINE_LENGTH)
        : subject,
  };
}
