import type { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import {
  readLineGuards,
  type ReceiptLineGuards,
} from "../parsing/parse-receipt";
import type { ReceiptParserDefinition } from "../parsing/receipt-parser.types";
import { validateReceiptParserDefinition } from "../parsing/receipt-parser.validation";
import type { ReceiptSourceLines } from "./receipt-source-lines";
import { rankReceiptParsers } from "./select-receipt-parser";

/**
 * Which parser reads an email (design section 6), and what stopped it when none
 * does.
 *
 * - `chosen`: the best approved parser for the sender whose lines (its own
 *   `source`: the text or the HTML part) satisfy its `requireLine`, with its
 *   validated definition and what its three line guards found.
 * - `invalid`: the first parser on the way whose stored definition fails
 *   validation. It stops the read (the person must fix it); the parsers after it
 *   are not tried.
 * - `none`: no parser applies. `needsHtml` is the first parser that reads the
 *   HTML part of an email that has none (it is passed over, as a `requireLine`
 *   miss is), so the caller can say `no_html` rather than `no_parser`.
 */
export type ReceiptParserChoice =
  | {
      kind: "chosen";
      parser: EmailReceiptParser;
      definition: ReceiptParserDefinition;
      guards: ReceiptLineGuards;
    }
  | { kind: "invalid"; parser: EmailReceiptParser }
  | { kind: "none"; needsHtml: EmailReceiptParser | null };

/** Pure: reads the parsers' definitions and the email's lines, writes nothing. */
export function chooseReceiptParser(
  parsers: readonly EmailReceiptParser[],
  email: { fromDomain: string; subject: string },
  sources: ReceiptSourceLines,
): ReceiptParserChoice {
  let needsHtml: EmailReceiptParser | null = null;
  for (const candidate of rankReceiptParsers(
    parsers,
    email.fromDomain,
    email.subject,
  )) {
    const validation = validateReceiptParserDefinition(candidate.definition);
    if (!validation.ok) return { kind: "invalid", parser: candidate };
    const lines = sources.forSource(validation.definition.source);
    if (lines === null) {
      needsHtml ??= candidate;
      continue;
    }
    const guards = readLineGuards(validation.definition, lines);
    if (!guards.applies) continue;
    return {
      kind: "chosen",
      parser: candidate,
      definition: validation.definition,
      guards,
    };
  }
  return { kind: "none", needsHtml };
}
