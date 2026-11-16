import { matchesAliasPattern } from "../payees/alias-match.util";

/**
 * Glob matching with named captures for the `matches` operator (design 10.1).
 *
 * `*` is an anonymous wildcard and `{name}` a wildcard whose text is kept. A
 * capture takes the SHORTEST run of characters that lets the rest of the
 * pattern match: every literal segment is searched once, left to right, at its
 * leftmost position, so there is no regex and no backtracking across
 * segments. A pattern without a capture is answered by `matchesAliasPattern`
 * itself, so the two agree on every such pattern by construction.
 */

/** Same bound as `matchesAliasPattern` (pattern and text; beyond it nothing matches). */
export const MAX_GLOB_LENGTH = 500;
export const MAX_CAPTURES_PER_PATTERN = 5;
/** A captured value is trimmed and cut to this many characters. */
export const MAX_CAPTURE_VALUE_LENGTH = 200;
export const CAPTURE_NAME = /^[a-z][a-z0-9]{0,19}$/;
/** A name the template language owns: it is not a capture name. */
export const RESERVED_CAPTURE_NAMES: readonly string[] = ["description"];

/** Longest `{...}` body worth looking at (a name plus room to see it is too long). */
const MAX_BRACE_BODY = 32;
const CAPTURE_LIKE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type GlobToken =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "star" }
  | { readonly kind: "capture"; readonly name: string };

export interface ParsedGlob {
  readonly tokens: readonly GlobToken[];
  /** Capture names in pattern order, duplicates kept (the validator reports them). */
  readonly captureNames: readonly string[];
  /**
   * `{...}` groups that look like an attempted capture but are not one
   * (`{Payee}`, `{}`, a name over 20 characters). They match as literal text;
   * the validator refuses them so a typo is never silently a literal.
   */
  readonly malformed: readonly string[];
}

/**
 * Split a pattern into literals, `*` and `{name}` captures. One pass over the
 * characters; a `{` that does not open a capture-shaped group is literal text
 * (so every pattern that never used captures reads exactly as before).
 */
export function parseGlob(pattern: string): ParsedGlob {
  // Rules arrive as JSON: refuse a non-string whose `length` would bound the loop.
  if (typeof pattern !== "string") {
    return { tokens: [], captureNames: [], malformed: [] };
  }
  const tokens: GlobToken[] = [];
  const captureNames: string[] = [];
  const malformed: string[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") tokens.push({ kind: "literal", text: literal });
    literal = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      flush();
      if (tokens[tokens.length - 1]?.kind !== "star") {
        tokens.push({ kind: "star" });
      }
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      const body =
        close !== -1 && close - i - 1 <= MAX_BRACE_BODY
          ? pattern.slice(i + 1, close)
          : null;
      if (body !== null && CAPTURE_NAME.test(body)) {
        flush();
        tokens.push({ kind: "capture", name: body });
        captureNames.push(body);
        i = close;
        continue;
      }
      if (body !== null && (body === "" || CAPTURE_LIKE.test(body))) {
        malformed.push(body);
      }
    }
    literal += ch;
  }
  flush();
  return { tokens, captureNames, malformed };
}

export type GlobCaptures = Readonly<Record<string, string>>;

const NO_CAPTURES: GlobCaptures = Object.freeze(Object.create(null));

/** A wildcard between two literal segments: the tokens that share the gap. */
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
 * Match `text` against a glob that may hold `{name}` captures, case
 * insensitively. Returns the captured values (trimmed, at most 200 characters
 * each) or null when the text does not match. Text or pattern over 500
 * characters never matches.
 *
 * Within a run of adjacent wildcards (`{a}{b}`, `*{a}`) the first ones take
 * nothing and the last one takes the run, the shortest-first reading applied
 * left to right.
 */
export function matchGlobWithCaptures(
  text: string,
  pattern: string,
): GlobCaptures | null {
  if (pattern.length > MAX_GLOB_LENGTH || text.length > MAX_GLOB_LENGTH) {
    return null;
  }
  const parsed = parseGlob(pattern);
  if (parsed.captureNames.length === 0) {
    return matchesAliasPattern(text, pattern) ? NO_CAPTURES : null;
  }
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

  const out: Record<string, string> = Object.create(null);
  let pos = head.length;
  for (let i = 0; i < gaps.length; i++) {
    let gapEnd: number;
    let next: number;
    if (i === gaps.length - 1) {
      gapEnd = suffixStart;
      next = suffixStart;
    } else {
      const literal = lits[i + 1];
      const at = lower.indexOf(literal, pos);
      if (at === -1 || at + literal.length > suffixStart) return null;
      gapEnd = at;
      next = at + literal.length;
    }
    const wild = gaps[i];
    const owner = wild[wild.length - 1];
    if (owner.kind === "capture") {
      out[owner.name] = clean(source.slice(pos, gapEnd));
    }
    for (const token of wild.slice(0, -1)) {
      if (token.kind === "capture") out[token.name] = "";
    }
    pos = next;
  }
  return Object.freeze(out);
}
