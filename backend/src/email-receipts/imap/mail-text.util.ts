import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import { stripControlCharacters } from "./strip-control-characters";

export { stripControlCharacters };

/**
 * One fetched message as the receipts pipeline stores it: headers reduced to the
 * fields the pipeline uses and the body reduced to text. The raw MIME source is
 * not kept (design 3.9); the HTML part is, for display only (`html`). This is
 * the ONLY file that imports `mailparser` (`imap-source-scan.spec.ts` holds
 * that).
 */
export interface ExtractedMailText {
  /** The Message-ID header, or null. */
  messageId: string | null;
  /** The first From address, lower-case; empty when the message names none. */
  fromAddress: string;
  /** The part of `fromAddress` after the last `@`, lower-case. */
  fromDomain: string;
  subject: string;
  /** The Date header, or null when absent or unreadable. */
  date: Date | null;
  text: string;
  /**
   * The HTML part as the sender wrote it, control characters stripped and cut to
   * `MAIL_TEXT_MAX_HTML_CHARS`, or null when the message has none. It is data for
   * display only: shown in a sandboxed frame that runs nothing and loads nothing,
   * never parsed, searched or sent to a model. `text` stays the one body every
   * parser and prompt reads.
   */
  html: string | null;
}

/** The bounds the `email_receipts` columns and CHECK enforce. */
export const MAIL_TEXT_MAX_BODY_CHARS = 100_000;
export const MAIL_TEXT_MAX_HTML_CHARS = 1_000_000;
export const MAIL_TEXT_MAX_SUBJECT_CHARS = 500;
export const MAIL_TEXT_MAX_FROM_ADDRESS_CHARS = 320;
export const MAIL_TEXT_MAX_FROM_DOMAIN_CHARS = 255;
export const MAIL_TEXT_MAX_MESSAGE_ID_CHARS = 500;

/**
 * The longest HTML part mailparser converts to text. A longer one rejects the
 * parse (the pipeline then records the message as skipped) instead of spending
 * the CPU: the message size cap already bounds it, this bounds the conversion.
 */
const MAX_HTML_CHARS_TO_CONVERT = 1_000_000;

const PARSER_OPTIONS = {
  skipImageLinks: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  maxHtmlLengthToParse: MAX_HTML_CHARS_TO_CONVERT,
} as const;

/** The first `max` characters, never ending on half of a surrogate pair. */
function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** One line: controls removed, whitespace runs collapsed, trimmed. */
function singleLine(value: string): string {
  return stripControlCharacters(value).replace(/\s+/g, " ").trim();
}

/**
 * HTML to text through mailparser's own converter, for a message whose HTML sits
 * where mailparser does not convert it (a `multipart/mixed` with no plain part).
 * The HTML is wrapped as a one-part message so it is the root, which mailparser
 * does convert; no second HTML-to-text dependency is needed.
 */
async function htmlToText(html: string): Promise<string> {
  const wrapped = Buffer.concat([
    Buffer.from(
      "MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n\r\n",
      "utf8",
    ),
    Buffer.from(Buffer.from(html, "utf8").toString("base64"), "utf8"),
  ]);
  const parsed = await simpleParser(wrapped, PARSER_OPTIONS);
  return parsed.text ?? "";
}

/**
 * The Date header, or null. mailparser answers "now" for a header it cannot
 * read, which would pass for a real date, so the raw header line is read here.
 */
function headerDate(parsed: ParsedMail): Date | null {
  const line = parsed.headerLines?.find((l) => l.key === "date")?.line;
  if (!line) return null;
  const value = line.slice(line.indexOf(":") + 1).trim();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function bodyText(parsed: ParsedMail): Promise<string> {
  if (typeof parsed.text === "string" && parsed.text.trim() !== "") {
    return parsed.text;
  }
  if (typeof parsed.html === "string" && parsed.html.trim() !== "") {
    return htmlToText(parsed.html);
  }
  return "";
}

/** The HTML part, bounded and stripped of control characters, or null when there is none. */
function bodyHtml(parsed: ParsedMail): string | null {
  if (typeof parsed.html !== "string" || parsed.html.trim() === "") return null;
  const html = cap(
    stripControlCharacters(parsed.html),
    MAIL_TEXT_MAX_HTML_CHARS,
  );
  return html.trim() === "" ? null : html;
}

/**
 * Read a fetched message's headers and body. Plain text wins as the text; HTML-
 * only mail is converted to text; the HTML part, when there is one, is kept as
 * well, for display (`html`). Every value is bounded to its column and stripped
 * of control characters, because this text is data from whoever wrote to the
 * mailbox. Rejects when the message cannot be parsed, which the pipeline records
 * as a skipped message.
 */
export async function extractMailText(
  source: Buffer,
): Promise<ExtractedMailText> {
  const parsed = await simpleParser(source, PARSER_OPTIONS);

  const address = (parsed.from?.value?.[0]?.address ?? "").trim().toLowerCase();
  const fromAddress = cap(
    singleLine(address),
    MAIL_TEXT_MAX_FROM_ADDRESS_CHARS,
  );
  const at = fromAddress.lastIndexOf("@");
  const fromDomain = cap(
    at >= 0 ? fromAddress.slice(at + 1).toLowerCase() : "",
    MAIL_TEXT_MAX_FROM_DOMAIN_CHARS,
  );
  const messageId = parsed.messageId
    ? cap(singleLine(parsed.messageId), MAIL_TEXT_MAX_MESSAGE_ID_CHARS)
    : null;
  const date = headerDate(parsed);

  return {
    messageId: messageId === "" ? null : messageId,
    fromAddress,
    fromDomain,
    subject: cap(singleLine(parsed.subject ?? ""), MAIL_TEXT_MAX_SUBJECT_CHARS),
    date,
    text: cap(
      stripControlCharacters(await bodyText(parsed)),
      MAIL_TEXT_MAX_BODY_CHARS,
    ),
    html: bodyHtml(parsed),
  };
}
