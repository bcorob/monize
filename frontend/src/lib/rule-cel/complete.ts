/**
 * Autocomplete for the expression view, by the context before the caret:
 * `transaction.` offers fields, `transaction.amount.` the methods that field
 * allows, `transaction.amount ` its comparison operators, a comparison the
 * values (enum members, `true`, references) and, inside `account("`, the names
 * of the accounts. What is inserted is always the written form, a name, never
 * an id.
 *
 * Pure: text and caret in, a replacement range and the items out. No library.
 */
import { ENTITY_KIND_OF_FIELD, isEntityKind, type CelEntityKind, type EntityIndex } from '@/lib/rule-cel/catalog';
import { tokenizeLoose, type Token } from '@/lib/rule-cel/lexer';
import { quoteString } from '@/lib/rule-cel/literal';
import { COMPARISON_TOKENS, METHOD_NAMES } from '@/lib/rule-cel/printer';
import { RULE_CONDITION_FIELDS, RULE_FIELDS, isEditorRuleField, isRuleField } from '@/lib/rule-fields';
import type { RuleField } from '@/types/transaction-rule';

export interface Suggestion {
  /** What the list shows. */
  readonly label: string;
  /** What replaces the range. */
  readonly insert: string;
  /** A catalog key under `rules.editor` (`fields.description`, `operators.eq`) that explains the item. */
  readonly hint?: string;
}

export interface Completion {
  /** The range of the text the chosen item replaces. */
  readonly from: number;
  readonly to: number;
  readonly items: readonly Suggestion[];
}

/** How many items an entity list offers at once; the rest are one more letter away. */
export const MAX_ENTITY_SUGGESTIONS = 8;

const COMPARISONS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const;
const START_WORDS = ['transaction.', 'isEmpty(', 'all(', 'any(', 'true', 'false'] as const;
const IDENT_PART = /[A-Za-z0-9_]/;

const startsWith = (word: string, prefix: string): boolean => word.toLowerCase().startsWith(prefix.toLowerCase());

/** The last `transaction.<field>` before the caret: the field a value or method belongs to. */
function currentField(tokens: readonly Token[]): RuleField | null {
  for (let i = tokens.length - 1; i >= 2; i -= 1) {
    const [root, dot, name] = [tokens[i - 2], tokens[i - 1], tokens[i]];
    if (root.text === 'transaction' && dot.text === '.' && name.kind === 'ident' && isRuleField(name.text)) return name.text;
  }
  return null;
}

/** The names of one kind that fit what was typed, prefix matches first. */
function entityItems(index: EntityIndex, kind: CelEntityKind, typed: string, form: (name: string, ordinal: number | null) => string): Suggestion[] {
  const needle = typed.toLowerCase();
  const fits = index.list(kind).filter((e) => e.name.toLowerCase().includes(needle));
  const ranked = [...fits.filter((e) => e.name.toLowerCase().startsWith(needle)), ...fits.filter((e) => !e.name.toLowerCase().startsWith(needle))];
  return ranked.slice(0, MAX_ENTITY_SUGGESTIONS).map((e) => {
    const insert = form(e.name, e.ordinal);
    return { label: e.ordinal === null ? e.name : `${e.name} (${e.ordinal})`, insert };
  });
}

/** Where a half-typed string ends: its closing quote and the `)` after it are replaced with it. */
function stringEnd(text: string, caret: number, quote: string, closer: string): number {
  const rest = text.slice(caret);
  const closed = new RegExp(`^[^${quote}\\n]*${quote}`).exec(rest);
  let end = caret + (closed ? closed[0].length : 0);
  if (closer !== '' && text[end] === closer) end += 1;
  return end;
}

function inString(text: string, caret: number, tokens: readonly Token[], open: { start: number; value: string }, index: EntityIndex): Completion | null {
  const quote = text[open.start];
  const [callee, paren] = [tokens[tokens.length - 2], tokens[tokens.length - 1]];
  if (paren?.text === '(' && callee?.kind === 'ident' && isEntityKind(callee.text)) {
    const kind = callee.text;
    const items = entityItems(index, kind, open.value, (name, ordinal) => `${quoteString(name)}${ordinal === null ? '' : `, ${ordinal}`})`);
    return items.length === 0 ? null : { from: open.start, to: stringEnd(text, caret, quote, ')'), items };
  }
  const field = currentField(tokens);
  const before = tokens[tokens.length - 1];
  if (field && before && ['[', ',', '==', '!=', '('].includes(before.text)) {
    const spec = RULE_CONDITION_FIELDS[field];
    if (spec.kind === 'enum') {
      const items = (spec.enumValues ?? [])
        .filter((v) => startsWith(v, open.value))
        .map((v) => ({ label: v, insert: quoteString(v), hint: field === 'type' ? `types.${v}` : undefined }));
      return items.length === 0 ? null : { from: open.start, to: stringEnd(text, caret, quote, ''), items };
    }
  }
  return null;
}

function operatorItems(field: RuleField, typed: string): Suggestion[] {
  const allowed = RULE_CONDITION_FIELDS[field].operators;
  const items: Suggestion[] = COMPARISONS.filter((op) => allowed.includes(op)).map((op) => ({
    label: COMPARISON_TOKENS[op] as string,
    insert: `${COMPARISON_TOKENS[op]} `,
    hint: `operators.${op}`,
  }));
  if (allowed.includes('in')) items.push({ label: 'in', insert: 'in ', hint: 'operators.in' });
  return items.filter((item) => item.label.startsWith(typed.toLowerCase()));
}

function valueItems(field: RuleField, index: EntityIndex, typed: string): Suggestion[] {
  const spec = RULE_CONDITION_FIELDS[field];
  if (spec.kind === 'enum') {
    return (spec.enumValues ?? []).filter((v) => startsWith(v, typed)).map((v) => ({ label: quoteString(v), insert: quoteString(v), hint: field === 'type' ? `types.${v}` : undefined }));
  }
  if (spec.kind === 'boolean') return ['true', 'false'].filter((v) => startsWith(v, typed)).map((v) => ({ label: v, insert: v }));
  const kind = ENTITY_KIND_OF_FIELD[spec.kind];
  if (!kind || !startsWith(kind, typed)) return [];
  return entityItems(index, kind, '', (name, ordinal) => `${kind}(${quoteString(name)}${ordinal === null ? '' : `, ${ordinal}`})`).map((item) => ({
    ...item,
    label: item.insert,
  }));
}

/**
 * What can be typed at `caret`, or null when nothing is worth offering.
 * Only the text before the caret decides; a word the caret is inside of is
 * replaced whole.
 */
export function complete(text: string, caret: number, index: EntityIndex): Completion | null {
  const prefix = text.slice(0, caret);
  // `=`, `!`, `<` and `>` typed so far: a comparison being written.
  const symbol = /[=!<>]+$/.exec(prefix);
  const scanned = tokenizeLoose(symbol ? prefix.slice(0, symbol.index) : prefix);
  const tokens = scanned.tokens.filter((t) => t.kind !== 'eof');
  if (scanned.open) return inString(text, caret, tokens, scanned.open, index);

  const last = tokens[tokens.length - 1];
  const partial = !symbol && last?.kind === 'ident' && last.end === caret ? last : null;
  const before = partial ? tokens.slice(0, -1) : tokens;
  const typed = partial?.text ?? symbol?.[0] ?? '';
  let to = caret;
  while (partial && to < text.length && IDENT_PART.test(text[to])) to += 1;
  const range = { from: partial?.start ?? symbol?.index ?? caret, to };
  const done = (items: readonly Suggestion[]): Completion | null => (items.length === 0 ? null : { ...range, items });
  const tail = (n: number): string[] => before.slice(-n).map((t) => t.text);
  const previous = before[before.length - 1];

  if (tail(2).join(' ') === 'transaction .' && !symbol) {
    return done(RULE_FIELDS.filter((f) => startsWith(f, typed)).map((f) => ({ label: f, insert: f, hint: isEditorRuleField(f) ? `fields.${f}` : undefined })));
  }
  const fieldName = before[before.length - 2];
  if (tail(4)[0] === 'transaction' && tail(4)[1] === '.' && tail(4)[3] === '.' && fieldName?.kind === 'ident' && isRuleField(fieldName.text) && !symbol) {
    const field = fieldName.text;
    const methods = RULE_CONDITION_FIELDS[field].operators.flatMap((op) => {
      const name = METHOD_NAMES[op];
      return name && startsWith(name, typed) ? [{ label: name, insert: `${name}(`, hint: `operators.${op}` }] : [];
    });
    return done(methods);
  }
  if (tail(3)[0] === 'transaction' && tail(3)[1] === '.' && previous?.kind === 'ident' && isRuleField(previous.text) && caret > previous.end) {
    return done(operatorItems(previous.text, typed));
  }
  const field = currentField(before);
  const isComparison = previous?.kind === 'punct' && Object.values(COMPARISON_TOKENS).includes(previous.text);
  const inList = previous?.text === '[' || previous?.text === ',';
  const inCall = previous?.text === '(' && before[before.length - 2]?.text === 'inSubtree';
  if (field && !symbol && (isComparison || inList || inCall)) return done(valueItems(field, index, typed));
  if (symbol) return null;

  if (previous?.text === '(' && before[before.length - 2]?.text === 'isEmpty') {
    return done(['transaction.'].filter((w) => startsWith(w, typed)).map((w) => ({ label: w, insert: w })));
  }
  const startsExpression =
    previous === undefined || ['&&', '||', '!'].includes(previous.text) || (previous.text === '(' && !(before[before.length - 2]?.kind === 'ident' && isEntityKind(before[before.length - 2].text)));
  if (startsExpression && (partial || previous !== undefined)) {
    return done(START_WORDS.filter((w) => startsWith(w, typed)).map((w) => ({ label: w, insert: w })));
  }
  return null;
}

/** Applies a chosen item: the new text and where the caret goes. */
export function applySuggestion(text: string, completion: Completion, item: Suggestion): { text: string; caret: number } {
  const next = `${text.slice(0, completion.from)}${item.insert}${text.slice(completion.to)}`;
  return { text: next, caret: completion.from + item.insert.length };
}
