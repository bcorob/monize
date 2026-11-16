import type { ReceiptParserDefinition } from "../receipt-parser.types";

/**
 * Parsers for three mails whose structure the line-by-line language of the
 * first version could not read, each used for every mail of its kind in the
 * acceptance specs. Synthetic mails, synthetic ids.
 */
export const GATEWAY_CATEGORY_GOODS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const GATEWAY_CATEGORY_MARKETPLACE =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * A payment gateway (PayU): the sender is the gateway, the merchant is on a
 * labelled line, every value is Gmail-bold (`*...*`), and the whole payment is
 * one item named by "Opis płatności".
 */
export const PAYU_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  requireLine: ["*PayU*"],
  orderId: ["Numer transakcji: {orderid}"],
  total: ["Kwota: *{amount} PLN*"],
  paid: ["Kwota: *{amount} PLN*"],
  payee: [{ label: "Sprzedawca", value: "{payee}", within: 2 }],
  items: { single: { name: "Opis płatności: {*}{name}{*}" } },
  categoryRules: [
    {
      match: "*OLX*",
      field: "payee",
      categoryId: GATEWAY_CATEGORY_MARKETPLACE,
    },
  ],
  defaultCategoryId: GATEWAY_CATEGORY_GOODS,
};

/**
 * Google Play: the order number sits between literal asterisks, the product
 * line carries the developer in parentheses and wraps when the name is long
 * (joinWrapped), "Razem" is the list price, the promotion line is the
 * discount (its text wraps, the amount is on the last line), the card line is
 * what was paid; a VAT note must never be an amount.
 */
export const GOOGLE_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  orderId: ["*Numer zamówienia:* {orderid}"],
  total: ["Razem: {amount} zł"],
  paid: ["Visa-*: {amount} zł", "Razem: {amount} zł"],
  discount: ["*{*} -{amount} zł"],
  items: {
    startAfter: "Produkt Cena",
    stopAt: "Razem",
    joinWrapped: true,
    patterns: ["{name} (deweloper: *) {amount} zł", "{name} {amount} zł"],
  },
  defaultCategoryId: GATEWAY_CATEGORY_GOODS,
};

/**
 * Amazon: the name is the full text inside `[image: ...]` (the line under the
 * link is cut with "..."), or the line under the link in a mail without
 * images; the seller and condition lines, the links and the unit price (which
 * has lost its decimal separator: "4799zł") are dropped, the quantity is on
 * its own line, and the one item takes the order total.
 */
export const AMAZON_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  orderId: ["Nr zamówienia {orderid}"],
  total: ["Suma {amount}"],
  items: {
    startAfter: "Wyświetl lub edytuj zamówienie",
    stopAt: "Suma",
    skipLines: ["<*>", "*zł", "Sprzedawca *", "Stan: *", "*..."],
    record: [{ line: ["[image: {name}]", "{name}"] }, { line: "Ilość: {qty}" }],
  },
  defaultCategoryId: GATEWAY_CATEGORY_GOODS,
};
