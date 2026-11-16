import { parseReceiptTraced } from "./parse-receipt";
import type { ReceiptParserDefinition } from "./receipt-parser.types";

/**
 * The `reference` field (design 5.5): an identifier the shop or the payment
 * gateway puts into the bank operation. Same entry shapes and priority rules as
 * the other fields, capture `{reference}`, read like an order number (the first
 * token; a line pattern reads the subject first).
 */

const read = (
  def: Partial<ReceiptParserDefinition>,
  lines: string[],
  subject = "",
) =>
  parseReceiptTraced(
    { version: 2, ...def } as ReceiptParserDefinition,
    subject,
    lines.join("\n"),
    null,
  );

describe("the reference field", () => {
  it("is null when the definition has none, and when nothing matches", () => {
    expect(read({}, ["Payment id: 123456"]).parsed.reference).toBeNull();
    expect(
      read({ reference: ["Payment id: {reference}"] }, ["nothing here"]).parsed
        .reference,
    ).toBeNull();
  });

  it("reads the value a line pattern captures", () => {
    const { parsed, trace } = read({ reference: ["Payment id: {reference}"] }, [
      "Hello",
      "Payment id: 4455667788",
    ]);
    expect(parsed.reference).toBe("4455667788");
    expect(trace.reference).toMatchObject({
      entry: 0,
      pattern: "Payment id: {reference}",
      line: { line: 2, text: "Payment id: 4455667788" },
    });
  });

  it("keeps only the first token, as an order number does", () => {
    expect(
      read({ reference: ["Payment id: {reference}"] }, [
        "Payment id: 4455667788 (card ending 1234)",
      ]).parsed.reference,
    ).toBe("4455667788");
  });

  it("reads the subject before the lines for a line pattern", () => {
    const { parsed, trace } = read(
      { reference: ["Payment {reference}"] },
      ["Payment LINEREF"],
      "Payment SUBJREF",
    );
    expect(parsed.reference).toBe("SUBJREF");
    expect(trace.reference?.line.line).toBe(0);
  });

  it("tries the entries in array order, the first that reads wins", () => {
    const lines = ["Ref: GENERAL1", "Transaction ref: SPECIFIC1"];
    expect(
      read(
        { reference: ["Transaction ref: {reference}", "Ref: {reference}"] },
        lines,
      ).parsed.reference,
    ).toBe("SPECIFIC1");
    expect(
      read(
        { reference: ["Ref: {reference}", "Transaction ref: {reference}"] },
        lines,
      ).parsed.reference,
    ).toBe("GENERAL1");
  });

  it("takes a labelled entry: the value under the label", () => {
    const { parsed, trace } = read(
      {
        reference: [
          { label: "Numer transakcji", value: "{reference}", within: 2 },
        ],
      },
      ["Numer transakcji", "", "PAYU-998877"],
    );
    expect(parsed.reference).toBe("PAYU-998877");
    expect(trace.reference).toMatchObject({
      label: "Numer transakcji",
      labelLine: { line: 1 },
      line: { line: 2 },
    });
  });

  it("does not read a labelled entry from the subject", () => {
    expect(
      read(
        { reference: [{ label: "Subject", value: "{reference}" }] },
        ["Other"],
        "Subject REF-1",
      ).parsed.reference,
    ).toBeNull();
  });

  it("is independent of the order id", () => {
    const { parsed } = read(
      {
        orderId: ["Order {orderid}"],
        reference: ["Statement text: {reference}"],
      },
      ["Order ORD-1", "Statement text: SHOP*99"],
    );
    expect(parsed.orderId).toBe("ORD-1");
    expect(parsed.reference).toBe("SHOP*99");
  });

  it("does not make an otherwise empty receipt complete", () => {
    const { parsed } = read({ reference: ["Ref: {reference}"] }, [
      "Ref: ABCD1234",
    ]);
    expect(parsed.reference).toBe("ABCD1234");
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("no_total");
  });
});
