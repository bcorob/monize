/**
 * The scanner: text to tokens. Strict for the parser (the first problem
 * throws with its position) and loose for autocomplete (a half-typed string
 * is reported as open, and a character the scanner does not know is skipped).
 */
import { ESCAPE_IN } from '@/lib/rule-cel/literal';
import { celError } from '@/lib/rule-cel/types';

export type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The source text of the token. */
  readonly text: string;
  /** The decoded string, or the number; the source text for the rest. */
  readonly value: string | number;
  readonly start: number;
  readonly end: number;
}

/** A string that has no closing quote yet: what a person typing one looks like. */
export interface OpenString {
  readonly start: number;
  /** The characters typed so far, escapes decoded. */
  readonly value: string;
}

export interface Scan {
  readonly tokens: Token[];
  readonly open: OpenString | null;
}

const TWO_CHAR = new Set(['&&', '||', '==', '!=', '<=', '>=']);
// Operators CEL has and the subset does not: scanned so the parser can say "not supported".
const ONE_CHAR = new Set(['(', ')', '[', ']', ',', '.', '!', '<', '>', '-', '+', '*', '/', '%', '?', ':', '{', '}']);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

interface Scanned {
  readonly value: string;
  readonly end: number;
  readonly closed: boolean;
}

function scanString(text: string, start: number, loose: boolean): Scanned {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) return { value, end: i + 1, closed: true };
    if (ch === '\n') break;
    if (ch !== '\\') {
      value += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next !== undefined && ESCAPE_IN[next] !== undefined) {
      value += ESCAPE_IN[next];
      i += 2;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 6;
    } else if (loose) {
      i += 2;
    } else {
      throw celError(i, 'invalidEscape', {}, 2);
    }
  }
  if (!loose) throw celError(start, 'unterminatedString', {}, i - start);
  return { value, end: i, closed: false };
}

// Sticky, so a long text of numbers is scanned in one pass rather than sliced per number.
const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function scanNumber(text: string, start: number): Token {
  NUMBER.lastIndex = start;
  const source = NUMBER.exec(text)?.[0] ?? '';
  const end = start + source.length;
  // `12abc`, `1.` and `0x10` are not numbers of this language.
  if (end < text.length && (IDENT_PART.test(text[end]) || (text[end] === '.' && DIGIT.test(text[end + 1] ?? '')))) {
    throw celError(start, 'badNumber', {}, end - start + 1);
  }
  return { kind: 'number', text: source, value: Number(source), start, end };
}

function scan(text: string, loose: boolean): Scan {
  const tokens: Token[] = [];
  let open: OpenString | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const s = scanString(text, i, loose);
      if (!s.closed) {
        open = { start: i, value: s.value };
        break;
      }
      tokens.push({ kind: 'string', text: text.slice(i, s.end), value: s.value, start: i, end: s.end });
      i = s.end;
    } else if (DIGIT.test(ch)) {
      try {
        const token = scanNumber(text, i);
        tokens.push(token);
        i = token.end;
      } catch (error) {
        if (!loose) throw error;
        i += 1;
      }
    } else if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < text.length && IDENT_PART.test(text[end])) end += 1;
      tokens.push({ kind: 'ident', text: text.slice(i, end), value: text.slice(i, end), start: i, end });
      i = end;
    } else if (TWO_CHAR.has(text.slice(i, i + 2))) {
      tokens.push({ kind: 'punct', text: text.slice(i, i + 2), value: text.slice(i, i + 2), start: i, end: i + 2 });
      i += 2;
    } else if (ONE_CHAR.has(ch)) {
      tokens.push({ kind: 'punct', text: ch, value: ch, start: i, end: i + 1 });
      i += 1;
    } else if (loose) {
      i += 1;
    } else {
      throw celError(i, 'unexpectedChar', { char: ch });
    }
  }
  tokens.push({ kind: 'eof', text: '', value: '', start: text.length, end: text.length });
  return { tokens, open };
}

/** Tokens of a complete text; throws a `CelSyntaxError` at the first problem. */
export function tokenize(text: string): Token[] {
  return scan(text, false).tokens;
}

/** Tokens of what has been typed so far: never throws, reports an unclosed string. */
export function tokenizeLoose(prefix: string): Scan {
  return scan(prefix, true);
}
