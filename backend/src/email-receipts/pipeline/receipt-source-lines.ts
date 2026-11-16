import {
  scanReceiptHtml,
  type ReceiptHtmlScan,
  type StructuredHtmlData,
} from "../imap/html-lines.util";
import { normalizeReceiptLines } from "../parsing/receipt-lines";
import type { ReceiptLinesSource } from "../parsing/receipt-parser.types";

/** The two renderings of a stored email a parser can read. */
export interface ReceiptBodies {
  bodyText: string;
  bodyHtml: string | null;
}

/**
 * The lines of one stored email, by source, each computed at most once. A
 * parser reads `text` (the stored text, the default) or `html` (the lines of the
 * HTML part: `imap/html-lines.util.ts`); its patterns, guards and trace line
 * numbers all refer to the lines of the source it chose. Reads the stored email
 * only: nothing here writes.
 *
 * `forSource` answers null when the definition wants the HTML part and the
 * email has none; the caller reports `no_html` (the pipeline: `parse_failed`
 * with that reason; the test operations: the outcome `no_html`).
 *
 * Forwarded emails: the forwarded header block is detected on the TEXT
 * (`detectForwardedOriginal`) and only ever decides the sender, subject and date
 * columns; neither source drops it from its lines. The HTML lines of a Gmail
 * forward therefore start with the forward banner and the From/Date/Subject/To
 * lines, which no item pattern reads and which `startAfter` skips.
 */
export class ReceiptSourceLines {
  private textLines: string[] | null = null;
  private htmlScan: ReceiptHtmlScan | null | undefined;

  constructor(private readonly bodies: ReceiptBodies) {}

  text(): string[] {
    this.textLines ??= normalizeReceiptLines(this.bodies.bodyText);
    return this.textLines;
  }

  /** One pass over the HTML part gives its lines and its structured data. */
  private scan(): ReceiptHtmlScan | null {
    if (this.htmlScan === undefined) {
      const html = this.bodies.bodyHtml;
      this.htmlScan =
        typeof html !== "string" || html === "" ? null : scanReceiptHtml(html);
    }
    return this.htmlScan;
  }

  /** The lines of the HTML part, or null when the email has none. */
  html(): string[] | null {
    return this.scan()?.lines ?? null;
  }

  /** The JSON-LD scripts and microdata of the HTML part, or null when the email has none. */
  structured(): StructuredHtmlData | null {
    return this.scan()?.structured ?? null;
  }

  /** The lines of a definition's source (`text` when it names none); null for `html` with no HTML part. */
  forSource(source: ReceiptLinesSource | undefined): string[] | null {
    return source === "html" ? this.html() : this.text();
  }
}
