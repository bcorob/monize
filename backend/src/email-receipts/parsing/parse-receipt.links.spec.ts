import { parseReceiptLines, parseReceiptLinesTraced } from "./parse-receipt";
import { validateReceiptParserDefinition } from "./receipt-parser.validation";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_CONTRACT_1,
  ALLEGRO_PAY_CONTRACT_2,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
  ALLEGRO_PAY_REPAYMENT_LINES,
  ALLEGRO_PAY_REPAYMENT_SUBJECT,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "./fixtures/allegro-pay-mails";
import { ALLEGRO_DEFINITION } from "./fixtures/allegro-definition";
import { ALLEGRO_A_BODY, ALLEGRO_A_SUBJECT } from "./fixtures/allegro-a-single";
import { normalizeReceiptLines } from "./receipt-lines";
import type { ReceiptParserDefinition } from "./receipt-parser.types";

/** Linked receipts, synthetic emails: a repayment (settlement) and its purchase (component). */

describe("the Allegro Pay fixture definitions", () => {
  it("are accepted by the validator", () => {
    for (const def of [
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      ALLEGRO_PAY_COMPONENT_DEFINITION,
    ]) {
      expect(validateReceiptParserDefinition(def).ok).toBe(true);
    }
  });
});

describe("a settlement reading", () => {
  const read = () =>
    parseReceiptLinesTraced(
      ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      ALLEGRO_PAY_REPAYMENT_SUBJECT,
      ALLEGRO_PAY_REPAYMENT_LINES,
      null,
    );

  it("reads every purchase block as a part with link, amount, name and instalment", () => {
    const { parsed } = read();
    expect(parsed.items).toEqual([
      {
        name: "Klocki drewniane zestaw",
        qty: 1,
        amount: 1098900,
        categoryId: expect.any(String),
        link: ALLEGRO_PAY_CONTRACT_1,
        instalment: "1. spłata z 1",
      },
      {
        name: "Kawa ziarnista 250 g + 2 inne przedmioty",
        qty: 1,
        amount: 1630000,
        categoryId: expect.any(String),
        link: ALLEGRO_PAY_CONTRACT_2,
        instalment: "1. spłata z 3",
      },
    ]);
  });

  it("reads the paid amount, is complete and has no linkKey", () => {
    const { parsed, trace } = read();
    expect(parsed.paid).toBe(2728900);
    expect(parsed.complete).toBe(true);
    expect(parsed.reason).toBeNull();
    expect("linkKey" in parsed).toBe(false);
    expect("linkKey" in trace).toBe(false);
  });

  it("matches category rules on the name, not on the link", () => {
    const def: ReceiptParserDefinition = {
      ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      categoryRules: [
        { match: "*kawa*", categoryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        {
          match: "*1000000001*",
          categoryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        },
      ],
    };
    const { items } = parseReceiptLines(
      def,
      "",
      ALLEGRO_PAY_REPAYMENT_LINES,
      null,
    );
    expect(items[0].categoryId).toBe(def.defaultCategoryId);
    expect(items[1].categoryId).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  });

  it("leaves link and instalment out of an item that captured none", () => {
    const def: ReceiptParserDefinition = {
      version: 2,
      role: "settlement",
      items: { patterns: ["{name}: {amount} zł"] },
    };
    const { items } = parseReceiptLines(def, "", ["Kawa: 10,00 zł"], null);
    expect(Object.keys(items[0]).sort()).toEqual([
      "amount",
      "categoryId",
      "name",
      "qty",
    ]);
  });

  it("normalizes a link value that holds spaces", () => {
    const def: ReceiptParserDefinition = {
      version: 2,
      role: "settlement",
      items: { patterns: ["{link} | {name}: {amount} zł"] },
    };
    const { items } = parseReceiptLines(
      def,
      "",
      ["1000 000 003 | Kawa: 10,00 zł"],
      null,
    );
    expect(items[0].link).toBe("1000000003");
  });
});

describe("a component reading", () => {
  const read = (lines: readonly string[] = ALLEGRO_PAY_PURCHASE_LINES) =>
    parseReceiptLinesTraced(
      ALLEGRO_PAY_COMPONENT_DEFINITION,
      ALLEGRO_PAY_PURCHASE_SUBJECT,
      lines,
      null,
    );

  it("reads the link key from the labelled entry and the receipt is complete", () => {
    const { parsed, trace } = read();
    expect(parsed.linkKey).toBe(ALLEGRO_PAY_CONTRACT_2);
    expect(trace.linkKey).toMatchObject({
      entry: 0,
      pattern: "{link} (umowa*",
      label: "Umowa Allegro Pay",
    });
    expect(parsed.items.map((item) => item.amount)).toEqual([1400000, 100000]);
    expect(parsed.shipping).toBe(130000);
    expect(parsed.complete).toBe(true);
  });

  it("falls back to the second entry when the labelled one finds nothing", () => {
    const lines = ALLEGRO_PAY_PURCHASE_LINES.filter(
      (line) =>
        !line.toLowerCase().startsWith("umowa allegro pay") &&
        !line.includes("(umowa w załączniku)"),
    );
    const { parsed, trace } = read(lines);
    expect(parsed.linkKey).toBe(ALLEGRO_PAY_CONTRACT_2);
    expect(trace.linkKey?.entry).toBe(1);
  });

  it("normalizes a spaced link value: '1000 000 002' reads as 1000000002", () => {
    const lines = ALLEGRO_PAY_PURCHASE_LINES.map((line) =>
      line.startsWith(ALLEGRO_PAY_CONTRACT_2)
        ? "1000 000 002 (umowa w załączniku)"
        : line,
    );
    expect(read(lines).parsed.linkKey).toBe("1000000002");
  });

  it("sets linkKey to null (and its trace to null) when the email holds none", () => {
    const { parsed, trace } = read(["Dziękujemy za zamówienie"]);
    expect(parsed.linkKey).toBeNull();
    expect(trace.linkKey).toBeNull();
  });
});

describe("a standalone reading", () => {
  it("has no linkKey and is unchanged by the role and link keys", () => {
    const body = normalizeReceiptLines(ALLEGRO_A_BODY);
    const before = parseReceiptLines(
      ALLEGRO_DEFINITION,
      ALLEGRO_A_SUBJECT,
      body,
      null,
    );
    const withRole = parseReceiptLines(
      { ...ALLEGRO_DEFINITION, role: "standalone" },
      ALLEGRO_A_SUBJECT,
      body,
      null,
    );
    expect(withRole).toEqual(before);
    expect("linkKey" in before).toBe(false);
    expect(before.items.every((item) => !("link" in item))).toBe(true);
  });

  it("ignores a linkKey on a profile whose role is not component", () => {
    const def: ReceiptParserDefinition = {
      version: 2,
      linkKey: ["Key {link}"],
    };
    const { parsed, trace } = parseReceiptLinesTraced(
      def,
      "",
      ["Key 123"],
      null,
    );
    expect("linkKey" in parsed).toBe(false);
    expect("linkKey" in trace).toBe(false);
  });
});
