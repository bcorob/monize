/**
 * Captures in a rule, as the editor checks them before the server does.
 *
 * A `matches` pattern may name captures (`*Payee: {payee} Account*`) and the
 * text of a `set_payee_from_text` or `set_description` action may use them as
 * `{payee}`, next to the two placeholders the template language owns
 * (`{payeeText}`, `{description}`). The parsing here is a copy of the
 * backend's (`rule-glob-capture.ts`, `rule-template.ts`) and of the checks in
 * `rule-validation.ts`; `rule-captures.test.ts` reads the backend source and
 * fails when the two differ. The server stays the authority.
 */
import { MAX_RULE_TEXT_LENGTH } from '@/lib/rule-fields';
import type { EditorNode } from '@/lib/rule-tree';

export const MAX_CAPTURES_PER_PATTERN = 5;
/** A capture name: lowercase letters and digits, starting with a letter, 20 at most. */
export const CAPTURE_NAME = /^[a-z][a-z0-9]{0,19}$/;
/** A name the template language owns: it is not a capture name. */
export const RESERVED_CAPTURE_NAMES: readonly string[] = ['description'];
/** Placeholders the template language owns besides the rule's captures. */
export const TEMPLATE_BUILTINS: readonly string[] = ['payeeText', 'description'];

/** Longest `{...}` body worth looking at (a name plus room to see it is too long). */
const MAX_BRACE_BODY = 32;
const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CaptureCode =
  | 'INVALID_CAPTURE'
  | 'TOO_MANY_CAPTURES'
  | 'DUPLICATE_CAPTURE'
  | 'LOOKS_LIKE_REGEX'
  | 'PATTERN_WITHOUT_WILDCARD';

/**
 * Regex-only syntax, a literal character in a glob: a pattern using it never
 * matches what its author meant (`|`, a backslash, `.*`, a bracket class of 1 to
 * 3 characters). `^`, `$` and longer bracketed words stay allowed: a glob has no
 * escape, so they are the only way to write that literal text.
 * Held equal to the backend's `REGEX_ONLY_SYNTAX` by `rule-captures.test.ts`.
 */
export const REGEX_ONLY_SYNTAX = /[|\\]|\[[^\][]{1,3}\]/;

/** The `{...}` body opening at `at`, or null when it does not close within reach. */
function braceBody(text: string, at: number): { body: string; close: number } | null {
  const close = text.indexOf('}', at + 1);
  if (close === -1 || close - at - 1 > MAX_BRACE_BODY) return null;
  return { body: text.slice(at + 1, close), close };
}

export interface ParsedNames {
  /** Names in order, duplicates kept. */
  readonly names: readonly string[];
  /** `{...}` groups shaped like a name that are not a valid one (`{Payee}`, `{}`). */
  readonly malformed: readonly string[];
}

/** One pass over the text: which `{...}` groups are names (`isName`) and which only look like one. */
function scanBraces(text: string, isName: (body: string) => boolean): ParsedNames {
  const names: string[] = [];
  const malformed: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const found = braceBody(text, i);
    if (found === null) continue;
    if (isName(found.body)) {
      names.push(found.body);
      i = found.close;
    } else if (found.body === '' || NAME_LIKE.test(found.body)) {
      malformed.push(found.body);
    }
  }
  return { names, malformed };
}

/** The `{name}` captures of a `matches` pattern, and the groups that are not one. */
export function parseGlobCaptures(pattern: string): ParsedNames {
  return scanBraces(pattern, (body) => CAPTURE_NAME.test(body));
}

/** The placeholders of a template, and the groups that are not one. */
export function parseTemplateRefs(template: string): ParsedNames {
  return scanBraces(template, (body) => CAPTURE_NAME.test(body) || body === 'payeeText');
}

// ---- the pattern side ----------------------------------------------------

export interface PatternCheck {
  readonly codes: readonly CaptureCode[];
  /** Names this pattern adds to the ones the rule already has. */
  readonly names: readonly string[];
}

/**
 * The codes the server answers for one pattern, given the names the patterns
 * before it in the rule already defined: a regex and a bare word (no `*`, no
 * capture) are refused, so are `{Word}` and `{}`, a sixth capture, a reserved
 * name and a name used twice in the rule.
 */
export function checkPattern(pattern: string, seen: readonly string[]): PatternCheck {
  const { names, malformed } = parseGlobCaptures(pattern);
  const codes: CaptureCode[] = [];
  // An empty pattern is a missing value, which the editor reports on its own.
  if (pattern !== '') {
    if (REGEX_ONLY_SYNTAX.test(pattern)) codes.push('LOOKS_LIKE_REGEX');
    else if (!pattern.includes('*') && names.length === 0 && malformed.length === 0)
      codes.push('PATTERN_WITHOUT_WILDCARD');
  }
  const known = new Set(seen);
  let reserved = false;
  let duplicate = false;
  for (const name of names) {
    if (RESERVED_CAPTURE_NAMES.includes(name)) reserved = true;
    else if (known.has(name)) duplicate = true;
    known.add(name);
  }
  if (malformed.length > 0 || reserved) codes.push('INVALID_CAPTURE');
  if (names.length > MAX_CAPTURES_PER_PATTERN) codes.push('TOO_MANY_CAPTURES');
  if (duplicate) codes.push('DUPLICATE_CAPTURE');
  return { codes, names };
}

export interface LeafCaptureIssue {
  readonly uid: string;
  /** The server's path of the leaf, e.g. `condition.all[1]`. */
  readonly path: string;
  readonly codes: readonly CaptureCode[];
}

export interface CaptureScan {
  /** Every capture name the rule's patterns define, once each, in order of appearance. */
  readonly names: readonly string[];
  /** The `matches` leaves whose pattern the server would refuse. */
  readonly issues: readonly LeafCaptureIssue[];
}

/**
 * Walk the condition in the server's order (depth first, children in order),
 * collect the capture names and the patterns that would be refused. Like the
 * server, a pattern longer than the text limit is not looked at.
 */
export function scanCaptures(root: EditorNode, rootPath = 'condition'): CaptureScan {
  const names: string[] = [];
  const issues: LeafCaptureIssue[] = [];
  const visit = (node: EditorNode, path: string): void => {
    if (node.kind === 'group') {
      node.children.forEach((child, i) => visit(child, `${path}.${node.match}[${i}]`));
      return;
    }
    if (node.op !== 'matches' || typeof node.value !== 'string' || node.value.length > MAX_RULE_TEXT_LENGTH) return;
    const check = checkPattern(node.value, names);
    if (check.codes.length > 0) issues.push({ uid: node.uid, path, codes: check.codes });
    for (const name of check.names) if (!names.includes(name)) names.push(name);
  };
  visit(root, rootPath);
  return { names, issues };
}

// ---- the template side ---------------------------------------------------

export interface TemplateCheck {
  /** Groups shaped like a placeholder that are not one (`{Payee}`, `{}`). */
  readonly malformed: readonly string[];
  /** Placeholders that are neither a built-in nor a capture of this rule, once each. */
  readonly unknown: readonly string[];
}

export function checkTemplate(template: string, captures: readonly string[]): TemplateCheck {
  const { names, malformed } = parseTemplateRefs(template);
  const unknown = names.filter((name) => !TEMPLATE_BUILTINS.includes(name) && !captures.includes(name));
  return { malformed: [...new Set(malformed)].map(showPlaceholder), unknown: [...new Set(unknown)].map(showPlaceholder) };
}

/** A name as it is written in a template. */
export const showPlaceholder = (name: string): string => `{${name}}`;

/** The placeholders a template may use: the built-ins, then this rule's captures. */
export function availablePlaceholders(captures: readonly string[]): string[] {
  return [...TEMPLATE_BUILTINS, ...captures.filter((name) => !TEMPLATE_BUILTINS.includes(name))];
}
