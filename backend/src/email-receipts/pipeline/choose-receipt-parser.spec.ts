import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { chooseReceiptParser } from "./choose-receipt-parser";
import { ReceiptSourceLines } from "./receipt-source-lines";

const parser = (over: Partial<EmailReceiptParser> = {}): EmailReceiptParser =>
  Object.assign(new EmailReceiptParser(), {
    id: "p1",
    userId: "u1",
    name: "Shop",
    payeeId: null,
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    definition: { version: 2, total: ["Total: {amount}"] },
    status: "approved",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });

const EMAIL = { fromDomain: "shop.example.com", subject: "Order" };
const sources = (html: string | null = null, text = "Total: 1.00") =>
  new ReceiptSourceLines({ bodyText: text, bodyHtml: html });

describe("chooseReceiptParser", () => {
  it("chooses the best parser for the sender with its definition and what its guards found", () => {
    const choice = chooseReceiptParser([parser()], EMAIL, sources());
    expect(choice).toMatchObject({
      kind: "chosen",
      parser: { id: "p1" },
      definition: { version: 2 },
      guards: { applies: true, requireLine: null },
    });
  });

  it("is none for a sender no parser serves, and for no parsers at all", () => {
    expect(
      chooseReceiptParser(
        [parser({ fromDomains: ["other.example.org"] })],
        EMAIL,
        sources(),
      ),
    ).toEqual({ kind: "none", needsHtml: null });
    expect(chooseReceiptParser([], EMAIL, sources())).toEqual({
      kind: "none",
      needsHtml: null,
    });
  });

  it("passes over a parser whose requireLine finds no line, in the lines of its own source", () => {
    const text = parser({
      id: "text",
      definition: { version: 2, requireLine: ["*PayU*"] },
    });
    const html = parser({
      id: "html",
      createdAt: new Date("2026-09-02T00:00:00Z"),
      definition: { version: 2, source: "html", requireLine: ["Cell B"] },
    });
    // "Cell B" is a line of the HTML source only; "PayU" appears in neither.
    const choice = chooseReceiptParser(
      [text, html],
      EMAIL,
      sources("<td>Cell A</td><td>Cell B</td>"),
    );
    expect(choice).toMatchObject({ kind: "chosen", parser: { id: "html" } });
    expect(
      chooseReceiptParser([text], EMAIL, sources("<td>Cell B</td>")),
    ).toEqual({ kind: "none", needsHtml: null });
  });

  it("stops at an invalid definition on the way, trying nobody after it", () => {
    const bad = parser({ id: "bad", definition: {} });
    const good = parser({
      id: "good",
      createdAt: new Date("2026-09-02T00:00:00Z"),
    });
    expect(chooseReceiptParser([bad, good], EMAIL, sources())).toMatchObject({
      kind: "invalid",
      parser: { id: "bad" },
    });
  });

  it("passes over a parser that reads HTML for an email with none, and remembers the first", () => {
    const html = parser({
      id: "html",
      definition: { version: 2, source: "html" },
    });
    expect(chooseReceiptParser([html], EMAIL, sources(null))).toEqual({
      kind: "none",
      needsHtml: html,
    });
    // A later parser that reads the text still applies.
    const text = parser({
      id: "text",
      createdAt: new Date("2026-09-02T00:00:00Z"),
    });
    expect(
      chooseReceiptParser([html, text], EMAIL, sources(null)),
    ).toMatchObject({ kind: "chosen", parser: { id: "text" } });
  });

  it("never chooses a draft", () => {
    expect(
      chooseReceiptParser([parser({ status: "draft" })], EMAIL, sources()),
    ).toEqual({ kind: "none", needsHtml: null });
  });
});
