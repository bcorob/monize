import { parseReceipt, parseReceiptTraced } from "./parse-receipt";
import {
  AMAZON_DEFINITION,
  GATEWAY_CATEGORY_GOODS,
  GATEWAY_CATEGORY_MARKETPLACE,
  GOOGLE_DEFINITION,
  PAYU_DEFINITION,
} from "./fixtures/gateway-definitions";
import {
  PAYU_1_BODY,
  PAYU_1_NAME,
  PAYU_2_BODY,
  PAYU_2_NAME,
} from "./fixtures/payu-mails";
import {
  GOOGLE_1_BODY,
  GOOGLE_1_NAME,
  GOOGLE_1_ORDER_ID,
  GOOGLE_1_SUBJECT,
  GOOGLE_1_WRAPPED_BODY,
  GOOGLE_2_BODY,
  GOOGLE_2_NAME,
  GOOGLE_2_ORDER_ID,
} from "./fixtures/google-mails";
import {
  AMAZON_BOTH_BODY,
  AMAZON_IMAGE_ONLY_BODY,
  AMAZON_NAME,
  AMAZON_ORDER_ID,
  AMAZON_REAL_BODY,
  AMAZON_SUBJECT,
  AMAZON_UNDER_LINK_BODY,
} from "./fixtures/amazon-mails";
import { detectForwardedOriginal } from "../imap/forwarded-message";
import { resolveForwardedIdentity } from "../imap/forwarded-receipt";
import { normalizeReceiptLines } from "./receipt-lines";
import { ALLEGRO_A_BODY, ALLEGRO_A_SUBJECT } from "./fixtures/allegro-a-single";
import { validateReceiptParserDefinition } from "./receipt-parser.validation";
import type { ReceiptParserDefinition } from "./receipt-parser.types";

/**
 * The acceptance mails of the payment gateway, Google Play and Amazon
 * parsers: synthetic mails built to the structures those senders use, each
 * kind read by ONE definition and each complete.
 */

const read = (def: ReceiptParserDefinition, body: string) =>
  parseReceipt(def, "", body, null);

/** No value a parser reads may keep the `*` a mail client draws around bold text. */
const valuesOf = (parsed: ReturnType<typeof read>): string[] => [
  parsed.orderId ?? "",
  parsed.payee ?? "",
  ...parsed.items.map((item) => item.name),
];

describe("the gateway, Google Play and Amazon definitions", () => {
  it.each([
    ["PayU", PAYU_DEFINITION],
    ["Google Play", GOOGLE_DEFINITION],
    ["Amazon", AMAZON_DEFINITION],
  ])("%s is a valid definition", (_label, definition) => {
    expect(validateReceiptParserDefinition(definition)).toEqual({
      ok: true,
      definition,
    });
  });
});

describe("PayU: a gateway notice, the merchant on a labelled line, Gmail-bold values", () => {
  it("reads payment 1 completely, the name's two double quotes kept", () => {
    const parsed = read(PAYU_DEFINITION, PAYU_1_BODY);
    expect(PAYU_1_NAME.split('"')).toHaveLength(3);
    expect(parsed).toEqual({
      orderId: "5712867912",
      reference: null,
      total: 1494100,
      paid: 1494100,
      payee: "GRUPA OLX SP. Z O.O.",
      shipping: null,
      discount: null,
      items: [
        {
          name: PAYU_1_NAME,
          qty: 1,
          amount: 1494100,
          // The merchant decides the category: a payee rule, not the default.
          categoryId: GATEWAY_CATEGORY_MARKETPLACE,
        },
      ],
      shippingCategoryId: null,
      discountCategoryId: GATEWAY_CATEGORY_GOODS,
      complete: true,
      reason: null,
    });
  });

  it("reads payment 2 completely, with the default category", () => {
    const parsed = read(PAYU_DEFINITION, PAYU_2_BODY);
    expect(parsed).toMatchObject({
      orderId: "5057403174",
      total: 622400,
      paid: 622400,
      payee: "Sklep Modelarski Testowy S.A.",
      complete: true,
      reason: null,
      items: [
        {
          name: PAYU_2_NAME,
          qty: 1,
          amount: 622400,
          categoryId: GATEWAY_CATEGORY_GOODS,
        },
      ],
    });
  });

  it.each([PAYU_1_BODY, PAYU_2_BODY])(
    "keeps no asterisk in any value",
    (body) => {
      for (const value of valuesOf(read(PAYU_DEFINITION, body))) {
        expect(value).not.toContain("*");
        expect(value).not.toBe("");
      }
    },
  );

  it("is passed over by its requireLine when the mail is not from PayU", () => {
    const stranger = PAYU_1_BODY.replace(/PayU/g, "Gateway");
    expect(
      parseReceiptTraced(PAYU_DEFINITION, "", stranger, null).outcome,
    ).toBe("not_applicable");
    expect(
      parseReceiptTraced(PAYU_DEFINITION, "", PAYU_1_BODY, null).outcome,
    ).toBe("read");
  });
});

describe("Google Play: wrapped names, a card line under a promotion, a VAT note", () => {
  it("reads receipt 1 (a promotion): list price 24,99, paid 21,99, discount 3,00", () => {
    const parsed = read(GOOGLE_DEFINITION, GOOGLE_1_BODY);
    expect(parsed).toEqual({
      orderId: GOOGLE_1_ORDER_ID,
      reference: null,
      total: 249900,
      paid: 219900,
      payee: null,
      shipping: null,
      discount: 30000,
      items: [
        {
          name: GOOGLE_1_NAME,
          qty: 1,
          amount: 249900,
          categoryId: GATEWAY_CATEGORY_GOODS,
        },
      ],
      shippingCategoryId: null,
      discountCategoryId: GATEWAY_CATEGORY_GOODS,
      complete: true,
      reason: null,
    });
  });

  it("reads receipt 1 again when the product line is wrapped over two lines", () => {
    const parsed = read(GOOGLE_DEFINITION, GOOGLE_1_WRAPPED_BODY);
    expect(parsed.items).toEqual([
      {
        name: GOOGLE_1_NAME,
        qty: 1,
        amount: 249900,
        categoryId: GATEWAY_CATEGORY_GOODS,
      },
    ]);
    expect(parsed.complete).toBe(true);
  });

  it("reads the order number between literal asterisks, and the promotion amount on its last line", () => {
    const { parsed, trace } = parseReceiptTraced(
      GOOGLE_DEFINITION,
      "",
      GOOGLE_1_BODY,
      null,
    );
    expect(parsed.orderId).toBe(GOOGLE_1_ORDER_ID);
    expect(trace.discount?.line.text).toBe("w aplikacji* -3,00 zł");
    // The card line "Visa-1234: 21,99 zł" is not read as a discount (no "* -" before it).
    expect(parsed.discount).toBe(30000);
  });

  it("reads receipt 2 (no promotion, a name over three lines): total and paid 44,99", () => {
    const parsed = read(GOOGLE_DEFINITION, GOOGLE_2_BODY);
    expect(parsed).toMatchObject({
      orderId: GOOGLE_2_ORDER_ID,
      total: 449900,
      paid: 449900,
      discount: null,
      complete: true,
      reason: null,
      items: [{ name: GOOGLE_2_NAME, qty: 1, amount: 449900 }],
    });
  });

  it.each([GOOGLE_1_BODY, GOOGLE_2_BODY])(
    "never reads the VAT note as the total or what was paid",
    (body) => {
      const parsed = read(GOOGLE_DEFINITION, body);
      for (const vat of [46700, 84100]) {
        expect(parsed.total).not.toBe(vat);
        expect(parsed.paid).not.toBe(vat);
        expect(parsed.shipping).not.toBe(vat);
        expect(parsed.items.some((item) => item.amount === vat)).toBe(false);
      }
    },
  );

  it("gives 21,99 with a promotion and 44,99 without when the card line is listed before Razem", () => {
    // Priority by array order: the specific "Visa-..." entry, then "Razem".
    const onlyTotal: ReceiptParserDefinition = {
      ...GOOGLE_DEFINITION,
      total: ["Visa-*: {amount} zł", "Razem: {amount} zł"],
      paid: undefined,
    };
    expect(read(onlyTotal, GOOGLE_1_BODY).total).toBe(219900);
    expect(read(onlyTotal, GOOGLE_2_BODY).total).toBe(449900);
    // Reversed, the general entry wins and the card line is never consulted.
    const reversed: ReceiptParserDefinition = {
      ...onlyTotal,
      total: ["Razem: {amount} zł", "Visa-*: {amount} zł"],
    };
    expect(read(reversed, GOOGLE_1_BODY).total).toBe(249900);
  });
});

describe("Amazon: the name under the link or in [image: ...], no unit price, the total is the item", () => {
  it.each([
    [
      "the real structure: the full name in [image: ...], the cut name under the link",
      AMAZON_REAL_BODY,
    ],
    ["the name under the link", AMAZON_UNDER_LINK_BODY],
    ["the name only inside [image: ...]", AMAZON_IMAGE_ONLY_BODY],
    ["the name in both places", AMAZON_BOTH_BODY],
  ])(
    "reads one item of quantity 3 for 143,97, complete: %s",
    (_label, body) => {
      expect(read(AMAZON_DEFINITION, body)).toEqual({
        orderId: AMAZON_ORDER_ID,
        reference: null,
        total: 1439700,
        paid: null,
        payee: null,
        shipping: null,
        discount: null,
        items: [
          {
            name: AMAZON_NAME,
            qty: 3,
            amount: 1439700,
            categoryId: GATEWAY_CATEGORY_GOODS,
          },
        ],
        shippingCategoryId: null,
        discountCategoryId: GATEWAY_CATEGORY_GOODS,
        complete: true,
        reason: null,
      });
    },
  );

  it("emits the item once when the name appears twice", () => {
    expect(read(AMAZON_DEFINITION, AMAZON_BOTH_BODY).items).toHaveLength(1);
  });

  it("never reads the unit price '4799zł' as an amount, with or without the skip line", () => {
    const parsed = read(AMAZON_DEFINITION, AMAZON_UNDER_LINK_BODY);
    expect(parsed.items.some((item) => item.amount === 47990000)).toBe(false);
    const withoutSkip: ReceiptParserDefinition = {
      ...AMAZON_DEFINITION,
      items: {
        startAfter: "Wyświetl lub edytuj zamówienie",
        stopAt: "Suma",
        skipLines: ["<*>", "Sprzedawca *", "Stan: *"],
        record: [
          { line: ["[image: {name}]", "{name}"] },
          { line: "Ilość: {qty}" },
        ],
      },
    };
    const unskipped = read(withoutSkip, AMAZON_UNDER_LINK_BODY);
    expect(unskipped.items).toHaveLength(1);
    expect(unskipped.items[0].amount).toBe(1439700);
  });

  it("reads the total 'Suma 143.97zł' (a dot, no space before zł) and the order number behind U+202B", () => {
    const parsed = read(AMAZON_DEFINITION, AMAZON_REAL_BODY);
    expect(parsed.total).toBe(1439700);
    expect(AMAZON_REAL_BODY).toContain("\u202b");
    expect(parsed.orderId).toBe(AMAZON_ORDER_ID);
  });

  it("takes the full name from [image: ...], not the cut one under the link", () => {
    const [item] = read(AMAZON_DEFINITION, AMAZON_REAL_BODY).items;
    expect(item.name).toBe(AMAZON_NAME);
    expect(item.name.endsWith("...")).toBe(false);
  });
});

describe("the forwarded-message header of the real mails", () => {
  const cases: [string, string, string, string, string][] = [
    [
      "Allegro",
      ALLEGRO_A_BODY,
      "powiadomienia@allegro.pl",
      "2026-08-23T21:40:00.000Z",
      ALLEGRO_A_SUBJECT,
    ],
    [
      "Amazon",
      AMAZON_REAL_BODY,
      "auto-confirm@amazon.pl",
      "2026-09-05T19:13:00.000Z",
      AMAZON_SUBJECT,
    ],
    [
      "Google Play",
      GOOGLE_1_BODY,
      "googleplay-noreply@google.com",
      "2026-09-14T10:42:00.000Z",
      GOOGLE_1_SUBJECT,
    ],
  ];

  it.each(cases)(
    "%s: the original sender, date and whole subject are found",
    (_label, body, from, sentAt, subject) => {
      const found = detectForwardedOriginal(body);
      expect(found?.fromAddress).toBe(from);
      expect(found?.sentAt?.toISOString()).toBe(sentAt);
      expect(found?.subject).toBe(subject);
    },
  );

  it.each(cases)(
    "%s: the stored identity becomes the shop's and keeps the forwarder",
    (_label, body, from, sentAt) => {
      const identity = resolveForwardedIdentity(
        {
          fromAddress: "alice.example@example.com",
          fromDomain: "example.com",
          subject: "Fwd: x",
          forwardedBy: null,
          originalSentAt: null,
        },
        body,
        new Date("2026-10-04T08:33:42.000Z"),
        new Set(["alice.example@example.com"]),
      );
      expect(identity).toMatchObject({
        fromAddress: from,
        fromDomain: from.split("@")[1],
        forwardedBy: "alice.example@example.com",
      });
      expect(identity?.originalSentAt?.toISOString()).toBe(sentAt);
    },
  );

  it("normalises the pre-header of zero-width characters away", () => {
    const lines = normalizeReceiptLines(AMAZON_REAL_BODY);
    expect(
      lines.some(
        (line) =>
          /[\u200b-\u200f\u202a-\u202e\u00ad]/.test(line) ||
          line.includes("\u034f"),
      ),
    ).toBe(false);
    expect(lines).toContain(`Nr zamówienia ${AMAZON_ORDER_ID}`);
  });
});
