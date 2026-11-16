import type { ReceiptParserDefinition } from "../receipt-parser.types";

/**
 * A parser for the Allegro "Kupiłeś i zapłaciłeś" mail (sender
 * powiadomienia@allegro.pl), the mail that needs every part of the language:
 *
 * - the order number is in a link, `.../moje-allegro/zakupy/kupione/{id}?...`;
 * - the total sits on the line UNDER the label "RAZEM", followed by the same
 *   basket priced without the Smart! package (a labelled field);
 * - the delivery price sits under "Metoda dostawy", before the Smart! line;
 * - a product is a name, then its URL, its offer number, its URL again, its
 *   line total and, from a second unit on, "N × unit price": a block of lines
 *   whose link and offer-number lines are dropped by `skipLines`.
 */
export const ALLEGRO_CATEGORY_GOODS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ALLEGRO_CATEGORY_SHIPPING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const ALLEGRO_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  orderId: ["*/moje-allegro/zakupy/kupione/{orderid}?*"],
  total: [{ label: "RAZEM", value: "{amount} zł", within: 3 }],
  shipping: [{ label: "Metoda dostawy", value: "{amount} zł", within: 4 }],
  items: {
    startAfter: "od ",
    stopAt: "Metoda dostawy",
    skipLines: ["<*>", "(*)"],
    record: [
      { line: "{name}" },
      { line: "{amount} zł" },
      { line: "{qty} × {price} zł", optional: true },
    ],
  },
  defaultCategoryId: ALLEGRO_CATEGORY_GOODS,
  shippingCategoryId: ALLEGRO_CATEGORY_SHIPPING,
};
