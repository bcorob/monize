/**
 * String literals of the expression: printing one with its escapes, and the
 * one table the scanner reads them back with, so the two cannot disagree.
 */

/** Written where a value has not been chosen yet. */
export const CEL_UNFILLED = '_';

const ESCAPE_OUT: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** The characters after a backslash that stand for one character. */
export const ESCAPE_IN: Readonly<Record<string, string>> = {
  '\\': '\\',
  '"': '"',
  "'": "'",
  n: '\n',
  r: '\r',
  t: '\t',
};

/** A double-quoted literal; every control character is escaped so a value stays on one line. */
export function quoteString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ESCAPE_OUT[ch] !== undefined) out += ESCAPE_OUT[ch];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A number as text; `-0` keeps its sign, so a value survives the trip exactly. */
export function formatNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}
