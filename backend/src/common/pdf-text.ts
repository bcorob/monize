/**
 * A PDF's text layer (bond issue letters, relay attachments). `pdfjs-dist` is
 * published as ES modules only, so it is loaded with a dynamic `import()`, which
 * the compiler keeps native under `module: nodenext`. This is the one module that touches it. Jest cannot load an
 * ES module from `node_modules` in this project, so the unit tests of everything
 * else mock `extractPdfText`, and `pdf-text.spec.ts` reads a real saved PDF in a
 * child Node process with the same `PDF_OPEN_OPTIONS`.
 */

/**
 * pdf.js options (the document bytes are added by the caller): no system fonts,
 * no font-face injection, and no console noise. pdf.js 6 never evaluates
 * generated code, so there is no `isEvalSupported` switch to turn off.
 */
export const PDF_OPEN_OPTIONS = {
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
} as const;

export interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/** The text of the pages: each item's string, a newline where pdf.js ends a line. */
export function pagesToText(
  pages: readonly (readonly PdfTextItem[])[],
): string {
  let text = "";
  for (const items of pages) {
    for (const item of items)
      text += (item.str ?? "") + (item.hasEOL ? "\n" : "");
    text += "\n";
  }
  return text;
}

/**
 * Throws when the bytes are not a PDF, or when `maxPages` is given and the
 * document claims more. No `maxPages` means no cap (the relay's upload limit
 * bounds its size). Text is untrimmed; empty for an image-only PDF.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  maxPages?: number,
): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // A copy: pdf.js transfers the buffer to its worker and detaches it.
  const task = pdfjs.getDocument({
    ...PDF_OPEN_OPTIONS,
    data: new Uint8Array(bytes),
  });
  try {
    const document = await task.promise;
    if (maxPages !== undefined && document.numPages > maxPages) {
      throw new Error(`PDF has ${document.numPages} pages`);
    }
    const pages: PdfTextItem[][] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items as PdfTextItem[]);
      page.cleanup();
    }
    return pagesToText(pages);
  } finally {
    await task.destroy();
  }
}
