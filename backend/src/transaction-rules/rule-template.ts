import { stripHtml } from "../common/sanitization.util";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../common/transaction-note";
import { CAPTURE_NAME, GlobCaptures } from "./rule-glob-capture";
import { RuleDescriptionMode } from "./rule-action.types";

/**
 * The one renderer of the text in a rule action's template (design 10.2).
 * Plain text with `{capture}`, `{payeeText}` and `{description}` placeholders:
 * no expressions, no escapes, no nesting. Pure, and the only place that turns
 * a template into text, so the preview and the commit cannot render apart.
 */

/** `payees.name` is varchar(255). */
export const RULE_PAYEE_NAME_MAX_LENGTH = 255;
/** A description is `text`; the product limit is the shared note length. */
export const RULE_DESCRIPTION_MAX_LENGTH = TRANSACTION_NOTE_MAX_LENGTH;

/** Placeholders the template language owns besides the rule's captures. */
export const TEMPLATE_BUILTINS: readonly string[] = [
  "payeeText",
  "description",
];

const MAX_BRACE_BODY = 32;
const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TemplateToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly name: string };

export interface ParsedTemplate {
  readonly tokens: readonly TemplateToken[];
  /** Placeholder names in order, duplicates kept. */
  readonly refs: readonly string[];
  /** `{...}` groups shaped like a placeholder that are not one (`{Payee}`, `{}`). */
  readonly malformed: readonly string[];
}

const isRefName = (body: string): boolean =>
  CAPTURE_NAME.test(body) || body === "payeeText";

export function parseTemplate(template: string): ParsedTemplate {
  // Rules arrive as JSON: refuse a non-string whose `length` would bound the loop.
  if (typeof template !== "string") {
    return { tokens: [], refs: [], malformed: [] };
  }
  const tokens: TemplateToken[] = [];
  const refs: string[] = [];
  const malformed: string[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "{") {
      const close = template.indexOf("}", i + 1);
      const body =
        close !== -1 && close - i - 1 <= MAX_BRACE_BODY
          ? template.slice(i + 1, close)
          : null;
      if (body !== null && isRefName(body)) {
        flush();
        tokens.push({ kind: "ref", name: body });
        refs.push(body);
        i = close;
        continue;
      }
      if (body !== null && (body === "" || NAME_LIKE.test(body))) {
        malformed.push(body);
      }
    }
    text += ch;
  }
  flush();
  return { tokens, refs, malformed };
}

export interface TemplateValues {
  /** The captures of the same rule's condition. */
  readonly captures: GlobCaptures;
  /** The raw payee text of the row. */
  readonly payeeText: string | null;
  /** The description as the rules before this action left it. */
  readonly description: string | null;
}

/**
 * Render a template: each placeholder is replaced once, left to right, and a
 * substituted value is never scanned again. A placeholder with no value is the
 * empty string. Angle brackets are stripped from the result (`stripHtml`).
 * The text is not trimmed or bounded here; the callers below do that for
 * the field it lands in.
 */
export function renderRuleTemplate(
  template: string,
  values: TemplateValues,
): string {
  let out = "";
  for (const token of parseTemplate(template).tokens) {
    if (token.kind === "text") {
      out += token.text;
    } else if (token.name === "payeeText") {
      out += (values.payeeText ?? "").trim();
    } else if (token.name === "description") {
      out += values.description ?? "";
    } else {
      out += Object.prototype.hasOwnProperty.call(values.captures, token.name)
        ? values.captures[token.name]
        : "";
    }
  }
  return stripHtml(out) ?? "";
}

/** A payee name: whitespace folded, trimmed, at most the column length. Empty when nothing is left. */
export function renderPayeeName(
  template: string,
  values: TemplateValues,
): string {
  const folded = renderRuleTemplate(template, values)
    .replace(/\s+/g, " ")
    .trim();
  return folded.length > RULE_PAYEE_NAME_MAX_LENGTH
    ? folded.slice(0, RULE_PAYEE_NAME_MAX_LENGTH).trim()
    : folded;
}

/**
 * The description after an action: `replace` writes the rendered text,
 * `append` / `prepend` join it to the current text (the template carries its
 * own separator). Trimmed, at most the note length. Returns null when the
 * rendered text is blank in `replace` mode (a refusal); in `append` /
 * `prepend` a blank rendering leaves the current text as it is.
 */
export function composeDescription(
  current: string | null,
  rendered: string,
  mode: RuleDescriptionMode,
): string | null {
  const now = current ?? "";
  if (rendered.trim() === "") return mode === "replace" ? null : now;
  const joined =
    mode === "replace"
      ? rendered
      : mode === "append"
        ? now + rendered
        : rendered + now;
  const trimmed = joined.trim();
  return trimmed.length > RULE_DESCRIPTION_MAX_LENGTH
    ? trimmed.slice(0, RULE_DESCRIPTION_MAX_LENGTH).trim()
    : trimmed;
}
