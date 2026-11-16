import type { ReceiptParserDefinition } from "../receipt-parser.types";

/**
 * Linked receipts, synthetic: a deferred-payment repayment email (one block per
 * purchase it pays) and the shop's purchase email for the second of them. Both
 * print the contract number, the key that ties them. Contract numbers and the
 * seller are made up. Given as lines, as the parser reads them.
 */
export const ALLEGRO_PAY_CATEGORY_GOODS =
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ALLEGRO_PAY_CATEGORY_SHIPPING =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export const ALLEGRO_PAY_CONTRACT_1 = "1000000001";
export const ALLEGRO_PAY_CONTRACT_2 = "1000000002";

export const ALLEGRO_PAY_REPAYMENT_SUBJECT = "Dziękujemy za wpłatę";

/** The repayment: 109,89 for contract 1 (instalment 1 of 1) and 163,00 for contract 2 (1 of 3). */
export const ALLEGRO_PAY_REPAYMENT_LINES: string[] = [
  "Dziękujemy za wpłatę",
  "Kwota wpłaty łącznie",
  "272,89 zł",
  "Spłacone zakupy",
  "umowa Allegro Pay",
  ALLEGRO_PAY_CONTRACT_1,
  "data zakupu",
  "12.12.2025",
  "kwota wpłaty",
  "109,89 zł",
  "1. spłata z 1",
  "Spłacone przedmioty",
  "Zakup od Sklep Testowy z dnia 12.12.2025",
  "Klocki drewniane zestaw",
  "umowa Allegro Pay",
  ALLEGRO_PAY_CONTRACT_2,
  "data zakupu",
  "15.12.2025",
  "kwota wpłaty",
  "163,00 zł",
  "1. spłata z 3",
  "Spłacone przedmioty",
  "Zakup od Sklep Testowy z dnia 15.12.2025",
  "Kawa ziarnista 250 g + 2 inne przedmioty",
  "Pozdrawiamy",
];

export const ALLEGRO_PAY_PURCHASE_SUBJECT = "Dziękujemy za zamówienie";

/** The purchase for contract 2: two items (140,00 and 10,00) and shipping 13,00. */
export const ALLEGRO_PAY_PURCHASE_LINES: string[] = [
  "Dziękujemy za zamówienie",
  "Pozycje zamówienia",
  "Kawa ziarnista 250 g",
  "140,00 zł",
  "Filtry papierowe 100 szt.",
  "10,00 zł",
  "Koszt dostawy",
  "13,00 zł",
  "Razem do zapłaty",
  "163,00 zł",
  "Forma płatności",
  "Allegro Pay",
  "Umowa Allegro Pay",
  `${ALLEGRO_PAY_CONTRACT_2} (umowa w załączniku)`,
  "Tytuł przelewu",
  `Allegro Pay ${ALLEGRO_PAY_CONTRACT_2}`,
];

/**
 * The settlement profile: one record per purchase block (6 steps, the fixed
 * label lines dropped by `skipLines`): contract number, the date line, the
 * amount, the instalment text and the first product name.
 */
export const ALLEGRO_PAY_SETTLEMENT_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  role: "settlement",
  link: { fromDomains: ["shop.example.com"], daysBefore: 120 },
  paid: [{ label: "Kwota wpłaty łącznie", value: "{amount} zł" }],
  items: {
    startAfter: "Spłacone zakupy",
    skipLines: [
      "data zakupu",
      "kwota wpłaty",
      "Spłacone przedmioty",
      "Zakup od *",
    ],
    record: [
      { line: "umowa Allegro Pay" },
      { line: "{link}" },
      { line: "*" },
      { line: "{amount} zł" },
      { line: "{instalment}" },
      { line: "{name}" },
    ],
  },
  defaultCategoryId: ALLEGRO_PAY_CATEGORY_GOODS,
};

/** The purchase profile, read as a component keyed by the contract number. */
export const ALLEGRO_PAY_COMPONENT_DEFINITION: ReceiptParserDefinition = {
  version: 2,
  role: "component",
  linkKey: [
    { label: "Umowa Allegro Pay", value: "{link} (umowa*" },
    "Allegro Pay {link}",
  ],
  total: [{ label: "Razem do zapłaty", value: "{amount} zł" }],
  shipping: [{ label: "Koszt dostawy", value: "{amount} zł" }],
  items: {
    startAfter: "Pozycje zamówienia",
    stopAt: "Koszt dostawy",
    record: [{ line: "{name}" }, { line: "{amount} zł" }],
  },
  defaultCategoryId: ALLEGRO_PAY_CATEGORY_GOODS,
  shippingCategoryId: ALLEGRO_PAY_CATEGORY_SHIPPING,
};
