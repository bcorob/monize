import { ReceiptSourceLines } from "./receipt-source-lines";

const HTML =
  "<table><tr><td>Widget</td><td>9,99 zł</td></tr></table>" +
  '<script type="application/ld+json">{"@type":"Order"}</script>';

describe("ReceiptSourceLines", () => {
  it("answers the text lines for a definition with no source or the text source", () => {
    const lines = new ReceiptSourceLines({
      bodyText: "Widget  9,99 zł\n\nTotal 9,99",
      bodyHtml: HTML,
    });
    expect(lines.forSource(undefined)).toEqual([
      "Widget 9,99 zł",
      "Total 9,99",
    ]);
    expect(lines.forSource("text")).toEqual(["Widget 9,99 zł", "Total 9,99"]);
  });

  it("answers the HTML lines for the html source, one line per cell", () => {
    const lines = new ReceiptSourceLines({ bodyText: "x", bodyHtml: HTML });
    expect(lines.forSource("html")).toEqual(["Widget", "9,99 zł"]);
  });

  it("answers null for the html source when the email has no HTML part, and still the text", () => {
    for (const bodyHtml of [null, ""]) {
      const lines = new ReceiptSourceLines({ bodyText: "a\nb", bodyHtml });
      expect(lines.forSource("html")).toBeNull();
      expect(lines.html()).toBeNull();
      expect(lines.structured()).toBeNull();
      expect(lines.forSource("text")).toEqual(["a", "b"]);
    }
  });

  it("hands out the structured data of the same one pass", () => {
    const lines = new ReceiptSourceLines({ bodyText: "", bodyHtml: HTML });
    expect(lines.structured()?.jsonLd).toEqual(['{"@type":"Order"}']);
    expect(lines.html()).toBe(lines.html());
    expect(lines.structured()).toBe(lines.structured());
  });
});
