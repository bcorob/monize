import { execFileSync } from "child_process";
import { join } from "path";
import { PDF_OPEN_OPTIONS, pagesToText, PdfTextItem } from "./pdf-text";

const LETTER = join(
  __dirname,
  "../bonds/adapters/pl/series/fixtures",
  "edo0934-letter.pdf",
);
const PDFJS = join(
  __dirname,
  "../../node_modules/pdfjs-dist/legacy/build/pdf.mjs",
);

/** What `extractPdfText` does, in a Node process that can load the ES module. */
const DRIVER = `
import { readFileSync } from "node:fs";
const [pdfjsPath, file, options] = process.argv.slice(1);
const pdfjs = await import(pdfjsPath);
const data = new Uint8Array(readFileSync(file));
const task = pdfjs.getDocument({ ...JSON.parse(options), data });
const doc = await task.promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) {
  pages.push((await (await doc.getPage(n)).getTextContent()).items);
}
await task.destroy();
process.stdout.write(JSON.stringify(pages));
`;

describe("the issue letter PDF", () => {
  it("is read by pdfjs-dist into the text the parsers expect", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        DRIVER,
        PDFJS,
        LETTER,
        JSON.stringify(PDF_OPEN_OPTIONS),
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    );
    const text = pagesToText(JSON.parse(out) as PdfTextItem[][]);
    expect(text).toContain("LIST EMISYJNY nr 96/2024 Ministra Finansów");
    expect(text).toContain("z dnia 22 sierpnia 2024 r.");
    expect(text).toContain("W pierwszym okresie odsetkowym stopa procentowa");
    expect(text).toContain("EDO0934");
  });

  it("joins items into lines and pages", () => {
    expect(
      pagesToText([
        [
          { str: "a", hasEOL: false },
          { str: "b", hasEOL: true },
        ],
        [{ str: "c" }],
      ]),
    ).toBe("ab\n\nc\n");
  });
});
