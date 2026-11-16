import {
  GlobCaptures,
  GlobToken,
  MAX_CAPTURE_VALUE_LENGTH,
  MAX_GLOB_LENGTH,
  matchGlobWithCaptures,
  parseGlob,
} from "../../transaction-rules/rule-glob-capture";

/**
 * Pattern matching for one receipt line (and, part by part, for the
 * consecutive lines a multi-line pattern spans). A rule glob captures the
 * SHORTEST run for every capture followed by a literal, which reads `{name} {amount}` on
 * "USB-C cable 19.98" as name "USB-C" and amount "cable 19.98". Receipt lines
 * rarely have a delimiter a name cannot contain, so two strategies run in turn:
 *
 * 1. the rules' own lazy matcher (`matchGlobWithCaptures`);
 * 2. when the caller does not accept its result (or it found none), a greedy
 *    reading of the same pattern: literals are found right to left, each at its
 *    rightmost position, so every capture takes the LONGEST run that lets the
 *    rest of the pattern match.
 *
 * Both are anchored, case-insensitive, linear in the line length per literal,
 * and build no regular expression from the pattern. The caller decides what is
 * usable through `accept` (an amount that parses, a non-empty name), so a
 * result the lazy strategy accepts is never changed by the greedy one.
 */

/** A wildcard between two literal segments. */
type Wild = Extract<GlobToken, { kind: "star" | "capture" }>;

interface Segments {
  /** lits[0] anchors the start and lits[last] the end; either may be "". */
  readonly lits: string[];
  /** gaps[i] lies between lits[i] and lits[i + 1]. */
  readonly gaps: Wild[][];
}

function toSegments(tokens: readonly GlobToken[]): Segments {
  const lits: string[] = [""];
  const gaps: Wild[][] = [];
  let pendingGap: Wild[] | null = null;
  for (const token of tokens) {
    if (token.kind === "literal") {
      if (pendingGap !== null) {
        gaps.push(pendingGap);
        lits.push(token.text.toLowerCase());
        pendingGap = null;
      } else {
        lits[lits.length - 1] += token.text.toLowerCase();
      }
    } else {
      pendingGap ??= [];
      pendingGap.push(token);
    }
  }
  if (pendingGap !== null) {
    gaps.push(pendingGap);
    lits.push("");
  }
  return { lits, gaps };
}

function clean(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_CAPTURE_VALUE_LENGTH
    ? trimmed.slice(0, MAX_CAPTURE_VALUE_LENGTH).trim()
    : trimmed;
}

/**
 * The greedy reading. Within a run of adjacent wildcards the LAST CAPTURE takes
 * the run and the others (stars included) take nothing, so `*order #{orderid}*`
 * captures the text after "order #" rather than an empty string.
 */
function matchGreedy(text: string, pattern: string): GlobCaptures | null {
  const parsed = parseGlob(pattern);
  // A pattern without a capture has nothing for this strategy to add.
  if (parsed.captureNames.length === 0) return null;
  const { lits, gaps } = toSegments(parsed.tokens);
  const lower = text.toLowerCase();
  // Case folding can change the length; slice the original text only when
  // the offsets still line up.
  const source = lower.length === text.length ? text : lower;

  const last = lits.length - 1;
  const head = lits[0];
  const tail = lits[last];
  if (!lower.startsWith(head) || !lower.endsWith(tail)) return null;
  const suffixStart = lower.length - tail.length;
  if (suffixStart < head.length) return null;

  // starts[i] is where literal i begins; the last one is the suffix.
  const starts: number[] = new Array<number>(lits.length).fill(0);
  starts[last] = suffixStart;
  let limit = suffixStart;
  for (let i = last - 1; i >= 1; i--) {
    const latest = limit - lits[i].length;
    if (latest < head.length) return null;
    const at = lower.lastIndexOf(lits[i], latest);
    if (at < head.length) return null;
    starts[i] = at;
    limit = at;
  }

  const out: Record<string, string> = Object.create(null);
  for (let i = 0; i < gaps.length; i++) {
    const begin = i === 0 ? head.length : starts[i] + lits[i].length;
    const names = gaps[i].flatMap((token) =>
      token.kind === "capture" ? [token.name] : [],
    );
    names.forEach((name, index) => {
      out[name] =
        index === names.length - 1
          ? clean(source.slice(begin, starts[i + 1]))
          : "";
    });
  }
  return Object.freeze(out);
}

/**
 * A literal `*` in a pattern: `{*}` or `\*`. The rule matcher gives `*` one
 * meaning (any text), so the receipt wrapper swaps each literal asterisk, in the
 * pattern and in the line, for one private-use character before matching and
 * swaps it back in the captured values. The rule matcher itself is untouched.
 */
const LITERAL_STAR = "\uE000";
const LITERAL_STAR_IN_PATTERN = /\{\*\}|\\\*/g;
const LITERAL_STAR_OUT = new RegExp(LITERAL_STAR, "g");

/** What a value is trimmed of: whitespace and the `*` and `_` a mail client leaves around bold and italic text. */
const WRAPPING = /^[\s*_]+|[\s*_]+$/g;

function readable(captures: GlobCaptures): GlobCaptures {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(captures)) {
    out[name] = value.replace(LITERAL_STAR_OUT, "*").replace(WRAPPING, "");
  }
  return Object.freeze(out);
}

/**
 * The readings of one line by one one-line pattern, in the order they are
 * tried: the rules' lazy reading, then the greedy one. Lazy, so a caller that
 * takes the first reading never pays for the second.
 */
function* readings(pattern: string, line: string): Generator<GlobCaptures> {
  if (pattern.length > MAX_GLOB_LENGTH || line.length > MAX_GLOB_LENGTH) {
    return;
  }
  const glob = pattern.replace(LITERAL_STAR_IN_PATTERN, LITERAL_STAR);
  const text = line.replace(/\*/g, LITERAL_STAR);
  const lazy = matchGlobWithCaptures(text, glob);
  if (lazy !== null) yield readable(lazy);
  const greedy = matchGreedy(text, glob);
  if (greedy !== null) yield readable(greedy);
}

/**
 * The two characters `\n` in a pattern: the break between the lines of a
 * multi-line pattern. Each part matches one whole line, and the parts match
 * consecutive lines of the email (blank lines are never lines: see
 * `normalizeReceiptLines`). A line holds no line break, so the escape cannot
 * mean a character of the line.
 */
export const PATTERN_LINE_BREAK = "\\n";

/** The parts of a pattern, one per line it spans: a one-line pattern is one part. */
export function patternParts(pattern: string): string[] {
  return pattern.split(PATTERN_LINE_BREAK);
}

export const isMultiLinePattern = (pattern: string): boolean =>
  pattern.includes(PATTERN_LINE_BREAK);

/** The part of a pattern (0 for a one-line pattern) that holds capture `name`; 0 when none does. */
export function capturePart(pattern: string, name: string): number {
  const at = patternParts(pattern).findIndex((part) =>
    parseGlob(part).captureNames.includes(name),
  );
  return Math.max(at, 0);
}

/**
 * Match one line against one pattern: the rules' lazy reading first, then the
 * greedy one, each only as far as `accept` allows. Returns the captured values
 * of the first reading `accept` takes, or null when neither reading is usable.
 * A line or pattern over 500 characters never matches, and neither does a
 * multi-line pattern (one text is one line; `matchReceiptLines` reads lines).
 *
 * `{*}` and `\*` in the pattern are a literal `*`. A captured value is trimmed
 * of leading and trailing whitespace, `*` and `_` (Gmail renders bold as
 * `*text*`) and cut to 200 characters; `accept` sees the trimmed values.
 */
export function matchReceiptPattern(
  pattern: string,
  line: string,
  accept: (captures: GlobCaptures) => boolean,
): GlobCaptures | null {
  if (isMultiLinePattern(pattern)) return null;
  for (const read of readings(pattern, line)) {
    if (accept(read)) return read;
  }
  return null;
}

/** What a pattern read at a line: the captures and how many lines it took. */
export interface ReceiptLinesMatch {
  captures: GlobCaptures;
  span: number;
}

/**
 * The first combination of the parts' readings, in order (each part's lazy
 * reading before its greedy one, the first part varying slowest), whose
 * captures together `accept` takes. A capture name is in one part only (the
 * validator refuses a duplicate), so merging never overwrites.
 */
function firstAccepted(
  parts: readonly GlobCaptures[][],
  index: number,
  merged: GlobCaptures,
  accept: (captures: GlobCaptures) => boolean,
): GlobCaptures | null {
  if (index === parts.length) return accept(merged) ? merged : null;
  for (const reading of parts[index]) {
    const next = Object.freeze(
      Object.assign(
        Object.create(null) as Record<string, string>,
        merged,
        reading,
      ),
    );
    const found = firstAccepted(parts, index + 1, next, accept);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Match a pattern against the lines starting at `lines[at]`: a one-line
 * pattern against that line (`matchReceiptPattern`), a multi-line one part by
 * part against it and the lines after it, all of which must lie before `end`
 * (the end of an item section; the end of the email by default). `accept`
 * sees the captures of every part together. Each part has at most two
 * readings and a pattern at most `MAX_PATTERN_LINES` parts, so at most 32
 * combinations are tried.
 */
export function matchReceiptLines(
  pattern: string,
  lines: readonly string[],
  at: number,
  accept: (captures: GlobCaptures) => boolean,
  end: number = lines.length,
): ReceiptLinesMatch | null {
  const parts = patternParts(pattern);
  if (at < 0 || at + parts.length > Math.min(end, lines.length)) return null;
  if (parts.length === 1) {
    const captures = matchReceiptPattern(pattern, lines[at], accept);
    return captures === null ? null : { captures, span: 1 };
  }
  const read: GlobCaptures[][] = [];
  for (const [index, part] of parts.entries()) {
    const found = [...readings(part, lines[at + index])];
    if (found.length === 0) return null;
    read.push(found);
  }
  const captures = firstAccepted(read, 0, Object.freeze({}), accept);
  return captures === null ? null : { captures, span: parts.length };
}
