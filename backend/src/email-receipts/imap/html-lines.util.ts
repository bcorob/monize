import { Parser } from "htmlparser2";
import { foldWhitespace, normalizeLine } from "../parsing/receipt-lines";
import {
  MAX_LINE_LENGTH,
  MAX_PARSE_LINES,
} from "../parsing/receipt-parser.types";
import { MAIL_TEXT_MAX_HTML_CHARS } from "./mail-text.util";

/**
 * The HTML part of a stored email read in ONE streaming pass (`htmlparser2`'s
 * event parser; no document tree is built, only a small stack of open elements):
 *
 * - the LINES a parser may read (`htmlToReceiptLines`), declaratively: every
 *   block element and every table cell ends a line, so a product name that a
 *   text conversion wraps over several lines is one line here, and a cell holds
 *   one value;
 * - the STRUCTURED DATA a mail client reads for its order card
 *   (`collectStructuredData`): the text of every `application/ld+json` script and
 *   the schema.org microdata items, handed unjudged to `schema-org-order.ts`.
 *
 * This is the ONLY file that imports `htmlparser2` (`imap-source-scan.spec.ts`
 * holds that). Pure: no I/O, no clock, no regular expression over email text
 * beyond fixed, anchored tests on a short attribute value. Every bound below is
 * a constant, so the work is linear in the (capped) input and the output is
 * bounded however hostile the HTML is.
 *
 * Lines (design 5.1, "Lines source"): block elements (`BLOCK_TAGS`) and `td` /
 * `th` end the current line on both their opening and closing tag; inline text
 * accumulates and whitespace is folded to single spaces; `head`, `title`,
 * `script`, `style`, `noscript` and `template` show nothing; an `<img alt="X">`
 * is its own line `[image: X]`; an `<a href>` contributes its text inline and,
 * for an `http` or `https` href, a separate line `<href>` (what Gmail's text
 * part shows). The normalisation is the one a text line gets
 * (`normalizeLine`): invisible characters dropped, whitespace folded, a line cut
 * to `MAX_LINE_LENGTH`, empty lines dropped, at most `MAX_PARSE_LINES` kept. A
 * link line is cut INSIDE its brackets, so a long tracking URL still ends in `>`
 * and `<*>` in `skipLines` still drops it.
 */

/** Elements that end the current line when they open and when they close. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "br",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "hr",
  // Table cells: every one ends the line, so a row reads as one line per cell.
  "td",
  "th",
  // The same idea for the rest of the structural elements an email can use.
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "main",
  "nav",
  "aside",
  "figure",
  "figcaption",
  "form",
  "address",
  "center",
]);

/** Elements whose content is never shown as text. */
const HIDDEN_TAGS: ReadonlySet<string> = new Set([
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
]);

/** The attribute that carries an `itemprop` value, by tag (microdata). */
const URL_VALUE_ATTRIBUTE: Readonly<Record<string, string>> = {
  a: "href",
  link: "href",
  area: "href",
  img: "src",
  audio: "src",
  video: "src",
  source: "src",
  embed: "src",
  iframe: "src",
  track: "src",
  time: "datetime",
  data: "value",
  meter: "value",
  object: "data",
};

/** Bounds: the input, the open-element stack, and the structured data collected. */
export const HTML_LINES_MAX_INPUT_CHARS = MAIL_TEXT_MAX_HTML_CHARS;
export const HTML_SCAN_MAX_DEPTH = 512;
export const JSON_LD_MAX_SCRIPTS = 50;
export const JSON_LD_MAX_SCRIPT_CHARS = 100_000;
export const MICRODATA_MAX_ITEMS = 200;
export const MICRODATA_MAX_DEPTH = 10;
export const MICRODATA_MAX_PROPS = 2000;
export const MICRODATA_MAX_VALUE_CHARS = 1000;
const MICRODATA_MAX_TEXT_COLLECTORS = 16;
const MICRODATA_MAX_NAMES_PER_ELEMENT = 5;
const MICRODATA_MAX_NAME_CHARS = 100;
const MICRODATA_MAX_TYPES = 10;
const MICRODATA_MAX_TYPE_CHARS = 200;
/** The line buffer is folded whenever it grows past this, and stops growing once a folded line is still longer. */
const LINE_BUFFER_LIMIT = 4096;

/** A schema.org microdata item: its types and its properties in document order. */
export interface MicrodataItem {
  types: string[];
  props: MicrodataProp[];
}

/** One `itemprop` of an item: a text/attribute value, or a nested item. */
export interface MicrodataProp {
  name: string;
  value: string | MicrodataItem;
}

/** What the HTML carries for a program rather than a reader: unjudged, bounded. */
export interface StructuredHtmlData {
  /** The text of each `<script type="application/ld+json">` (at most 50, 100 KB each). */
  jsonLd: string[];
  /** The top-level microdata items (an element with `itemscope` that is nobody's property). */
  microdata: MicrodataItem[];
}

export interface ReceiptHtmlScan {
  lines: string[];
  structured: StructuredHtmlData;
}

interface Frame {
  /** Counted in `hiddenDepth` while open. */
  hidden: boolean;
  /** The `http(s)` href to put on its own line when the anchor closes. */
  href: string | null;
  /** The item this element opened (popped from the item stack on close). */
  item: MicrodataItem | null;
  /** An `itemprop` whose value is the element's text. */
  textProp: { owner: MicrodataItem; names: string[]; text: string } | null;
}

const hasOwn = (attribs: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(attribs, key);

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const isJsonLdType = (type: string | undefined): boolean =>
  type !== undefined && /^application\/ld\+json(?:\s*;.*)?$/i.test(type.trim());

/** The first `max` characters of a value, never ending on half of a surrogate pair. */
function cutText(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Whitespace-separated tokens of an attribute value, bounded in count and length. */
function tokens(
  value: string | undefined,
  max: number,
  chars: number,
): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  for (const word of value.split(/\s+/)) {
    if (word === "") continue;
    out.push(cutText(word, chars));
    if (out.length >= max) break;
  }
  return out;
}

class ReceiptHtmlHandler {
  readonly lines: string[] = [];
  readonly structured: StructuredHtmlData = { jsonLd: [], microdata: [] };

  private buffer = "";
  private hiddenDepth = 0;
  private readonly stack: Frame[] = [];
  /** Open elements past `HTML_SCAN_MAX_DEPTH`: counted so closes stay balanced, otherwise inert. */
  private overflow = 0;
  private readonly items: MicrodataItem[] = [];
  private itemCount = 0;
  private propCount = 0;
  private readonly collectors: Frame[] = [];
  private scripts = 0;
  private script: { text: string; over: boolean } | null = null;

  // ---------------------------------------------------------------- lines

  private addText(text: string): void {
    if (this.buffer.length > LINE_BUFFER_LIMIT) return;
    this.buffer += text;
    if (this.buffer.length > LINE_BUFFER_LIMIT) {
      this.buffer = foldWhitespace(this.buffer);
    }
  }

  private pushLine(raw: string): void {
    if (this.lines.length >= MAX_PARSE_LINES) return;
    const line = normalizeLine(raw);
    if (line !== "") this.lines.push(line);
  }

  /** End the current line. */
  private flush(): void {
    if (this.buffer === "") return;
    const raw = this.buffer;
    this.buffer = "";
    this.pushLine(raw);
  }

  // ------------------------------------------------------------ microdata

  private addProp(
    owner: MicrodataItem,
    name: string,
    value: string | MicrodataItem,
  ): void {
    if (this.propCount >= MICRODATA_MAX_PROPS) return;
    this.propCount += 1;
    owner.props.push({ name, value });
  }

  /** The text/attribute value of an `itemprop`, or null when it is the element's text. */
  private attributeValue(
    tag: string,
    attribs: Record<string, string>,
  ): string | null {
    const name = hasOwn(attribs, "content")
      ? "content"
      : URL_VALUE_ATTRIBUTE[tag];
    if (name === undefined || !hasOwn(attribs, name)) return null;
    return cutText(
      foldWhitespace(attribs[name]).trim(),
      MICRODATA_MAX_VALUE_CHARS,
    );
  }

  private openMicrodata(
    tag: string,
    attribs: Record<string, string>,
    frame: Frame,
  ): void {
    const names = hasOwn(attribs, "itemprop")
      ? tokens(
          attribs.itemprop,
          MICRODATA_MAX_NAMES_PER_ELEMENT,
          MICRODATA_MAX_NAME_CHARS,
        )
      : [];
    const owner =
      this.items.length > 0 ? this.items[this.items.length - 1] : null;

    if (
      hasOwn(attribs, "itemscope") &&
      this.items.length < MICRODATA_MAX_DEPTH &&
      this.itemCount < MICRODATA_MAX_ITEMS
    ) {
      this.itemCount += 1;
      const item: MicrodataItem = {
        types: tokens(
          attribs.itemtype,
          MICRODATA_MAX_TYPES,
          MICRODATA_MAX_TYPE_CHARS,
        ),
        props: [],
      };
      if (owner !== null && names.length > 0) {
        for (const name of names) this.addProp(owner, name, item);
      } else {
        this.structured.microdata.push(item);
      }
      frame.item = item;
      this.items.push(item);
      return;
    }

    if (owner === null || names.length === 0) return;
    const value = this.attributeValue(tag, attribs);
    if (value !== null) {
      if (value !== "")
        for (const name of names) this.addProp(owner, name, value);
      return;
    }
    if (this.collectors.length < MICRODATA_MAX_TEXT_COLLECTORS) {
      frame.textProp = { owner, names, text: "" };
      this.collectors.push(frame);
    }
  }

  private closeMicrodata(frame: Frame): void {
    if (frame.item !== null) this.items.pop();
    const prop = frame.textProp;
    if (prop === null) return;
    this.collectors.pop();
    const value = cutText(
      foldWhitespace(prop.text).trim(),
      MICRODATA_MAX_VALUE_CHARS,
    );
    if (value !== "")
      for (const name of prop.names) this.addProp(prop.owner, name, value);
  }

  // --------------------------------------------------------------- events

  onopentag(tag: string, attribs: Record<string, string>): void {
    if (
      tag === "script" &&
      isJsonLdType(attribs.type) &&
      this.scripts < JSON_LD_MAX_SCRIPTS
    ) {
      this.scripts += 1;
      this.script = { text: "", over: false };
    }
    if (this.stack.length >= HTML_SCAN_MAX_DEPTH) {
      // Too deep to track: inert, except that a block still ends its line.
      this.overflow += 1;
      if (this.hiddenDepth === 0 && BLOCK_TAGS.has(tag)) this.flush();
      return;
    }
    const frame: Frame = {
      hidden: HIDDEN_TAGS.has(tag),
      href: null,
      item: null,
      textProp: null,
    };
    const visible = this.hiddenDepth === 0 && !frame.hidden;
    this.openMicrodata(tag, attribs, frame);
    if (frame.hidden) this.hiddenDepth += 1;
    if (visible) {
      if (BLOCK_TAGS.has(tag)) this.flush();
      if (tag === "img") this.image(attribs);
      if (tag === "a" && typeof attribs.href === "string") {
        const href = foldWhitespace(attribs.href).trim();
        if (isHttpUrl(href)) frame.href = href;
      }
    }
    this.stack.push(frame);
  }

  private image(attribs: Record<string, string>): void {
    const alt = normalizeLine(attribs.alt ?? "");
    if (alt === "") return;
    this.flush();
    this.pushLine(`[image: ${alt}]`);
  }

  onclosetag(tag: string): void {
    if (this.overflow > 0) {
      this.overflow -= 1;
      if (this.hiddenDepth === 0 && BLOCK_TAGS.has(tag)) this.flush();
      return;
    }
    const frame = this.stack.pop();
    if (frame === undefined) return;
    this.closeMicrodata(frame);
    if (frame.hidden) this.hiddenDepth -= 1;
    if (tag === "script" && this.script !== null) {
      if (!this.script.over && this.script.text.trim() !== "") {
        this.structured.jsonLd.push(this.script.text);
      }
      this.script = null;
    }
    if (this.hiddenDepth > 0) return;
    if (frame.href !== null) {
      this.flush();
      const room = MAX_LINE_LENGTH - 2;
      this.pushLine(`<${cutText(frame.href, room)}>`);
    } else if (BLOCK_TAGS.has(tag)) {
      this.flush();
    }
  }

  ontext(text: string): void {
    if (this.script !== null) {
      if (this.script.over) return;
      if (this.script.text.length + text.length > JSON_LD_MAX_SCRIPT_CHARS) {
        this.script.over = true;
        this.script.text = "";
      } else {
        this.script.text += text;
      }
      return;
    }
    for (const frame of this.collectors) {
      const prop = frame.textProp;
      if (prop !== null && prop.text.length <= MICRODATA_MAX_VALUE_CHARS * 2) {
        prop.text += text;
      }
    }
    if (this.hiddenDepth === 0) this.addText(text);
  }

  onend(): void {
    this.flush();
  }
}

/** One pass over the HTML: its lines and its structured data. Total: bad input gives an empty scan. */
export function scanReceiptHtml(html: string): ReceiptHtmlScan {
  const handler = new ReceiptHtmlHandler();
  if (typeof html === "string" && html !== "") {
    const input =
      html.length > HTML_LINES_MAX_INPUT_CHARS
        ? cutText(html, HTML_LINES_MAX_INPUT_CHARS)
        : html;
    const parser = new Parser(handler, { decodeEntities: true });
    parser.write(input);
    parser.end();
  }
  return { lines: handler.lines, structured: handler.structured };
}

/** The lines of an HTML body, normalised like the lines of a text body (see the file comment). */
export function htmlToReceiptLines(html: string): string[] {
  return scanReceiptHtml(html).lines;
}

/** The JSON-LD scripts and microdata items of an HTML body. */
export function collectStructuredData(html: string): StructuredHtmlData {
  return scanReceiptHtml(html).structured;
}
