/**
 * Shared types of the expression mode: the errors the parser reports, and the
 * limits it enforces before it looks at a single token.
 *
 * The expression is a CEL-syntax VIEW of the same JSON condition tree the
 * visual editor edits (`docs/future-plans/transaction-rules.md` section 3.7).
 * Nothing here evaluates anything: there is no `eval` and no `new Function`.
 */

/** A longer text is refused before it is scanned, so a paste cannot stall the tab. */
export const MAX_EXPRESSION_LENGTH = 20000;

/** How many parentheses may be open at once; the tree's own depth limit is far lower. */
export const MAX_EXPRESSION_NESTING = 24;

/**
 * Every reason the parser refuses a text. Each key has a sentence in
 * `rules.editor.expression.errors` (`rules-catalog.test.ts` pins the set).
 */
export const CEL_ERROR_KEYS = [
  'tooLong',
  'unexpectedChar',
  'unterminatedString',
  'invalidEscape',
  'badNumber',
  'expectedExpression',
  'expectedField',
  'expectedOperator',
  'expectedValue',
  'expectedSymbol',
  'unexpectedToken',
  'unsupported',
  'unknownField',
  'unknownFunction',
  'operatorNotAllowed',
  'wrongValueType',
  'invalidEnum',
  'invalidCurrency',
  'valueTooLong',
  'listTooLong',
  'unknownEntity',
  'ambiguousEntity',
  'entityOrdinal',
  'maxDepth',
  'maxLeaves',
  'maxNodes',
  'tooNested',
] as const;

export type CelErrorKey = (typeof CEL_ERROR_KEYS)[number];

export type CelErrorArgs = Readonly<Record<string, string | number>>;

/** A refusal: where it is (a 0-based offset into the text), what it is, and its message arguments. */
export interface CelError {
  readonly position: number;
  /** How many characters the offending part spans; at least 1. */
  readonly length: number;
  readonly key: CelErrorKey;
  readonly args: CelErrorArgs;
}

/** Thrown inside the scanner and the parser; `parseCondition` turns it into a result. */
export class CelSyntaxError extends Error {
  constructor(readonly error: CelError) {
    super(error.key);
    this.name = 'CelSyntaxError';
  }
}

export function celError(
  position: number,
  key: CelErrorKey,
  args: CelErrorArgs = {},
  length = 1,
): CelSyntaxError {
  return new CelSyntaxError({ position, length: Math.max(1, length), key, args });
}

/** 1-based line and column of an offset, for the message a person reads. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
