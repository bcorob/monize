/**
 * Amazon.pl order confirmations ("Zamówione: ...") as Gmail's "Forward" leaves
 * them: the forwarded-message header block, a pre-header of invisible
 * characters, `[image: ...]` stand-ins, every link on its own line, the order
 * number after "Nr zamówienia" behind a right-to-left embedding (U+202B), the
 * full product name only inside `[image: ...]` (the line under the link is cut
 * with "..."), the seller and condition lines, the quantity, the unit price
 * WITHOUT its decimal separator ("4799zł" for 47,99) and the total.
 *
 * ANONYMISED from a real mail: the recipient, the town, the order number, the
 * seller and every link token are invented; the product name, the quantity and
 * the amounts are kept.
 */
export const AMAZON_NAME =
  "Mini Powerbank 10000mAh 22.5W PD QC USB C z zintegrowanym kablem";
export const AMAZON_ORDER_ID = "403-1234567-1234567";
export const AMAZON_SUBJECT = "Zamówione: 3 „Mini Powerbank 10000mAh...”";

const link = (tag: string): string =>
  `<https://www.amazon.pl/gp/r.html?C=EXAMPLE&R=${tag}&T=C&U=https%3A%2F%2Fwww.amazon.pl%2Fdp%2FB0TEST0001>`;
const INVISIBLE = "͏ ‌ ­".repeat(8);

const HEAD = [
  "---------- Forwarded message ---------",
  "Od: Amazon.pl <auto-confirm@amazon.pl>",
  "Date: sob., 5 wrz 2026 o 19:13",
  `Subject: ${AMAZON_SUBJECT}`,
  "To: <alice.example@example.com>",
  "",
  `${AMAZON_SUBJECT}${INVISIBLE}`,
  INVISIBLE,
  "Twoje zamówienia",
  link("orders"),
  "Twoje konto",
  link("account"),
  "Kup ponownie",
  link("buyagain"),
  "Dziękujemy za złożenie zamówienia!",
  "[image: Ukończono]",
  "Zamówione",
  "[image: W toku]",
  "Wysłano",
  "[image: W toku]",
  "W drodze do odbiorcy",
  "[image: W toku]",
  "Dostarczono",
  "Dostawa: poniedziałek",
  "*Alicja – Miasto*",
  `Nr zamówienia ‫${AMAZON_ORDER_ID}`,
  "Wyświetl lub edytuj zamówienie",
  link("details"),
];

const TAIL = [
  "Ilość: 3",
  "4799zł",
  "Suma 143.97zł",
  "Amazon.pl jest nazwą handlową Amazon EU Sarl, Amazon Europe Core Sarl i",
  "Amazon Media EU Sarl, podmiotów z siedzibą w Luksemburgu.",
  "© 2026 Amazon.com, Inc. i podmioty powiązane. Amazon i wszystkie związane",
  "marki stanowią znaki towarowe zarejestrowane na rzecz Amazon.com, Inc.",
  "Informacja o prywatności",
  link("privacy"),
  "[image: Amazon.com] [image: Amazon.com]",
  link("home"),
  "--",
  "Alicja Testowa",
  "",
];

/** As the real mail: the full name in `[image: ...]`, then the cut name under the link. */
export const AMAZON_REAL_BODY = [
  ...HEAD,
  `[image: ${AMAZON_NAME}]`,
  link("image"),
  "Mini Powerbank 10000mAh 22.5W PD ...",
  link("name"),
  "Sprzedawca SPRZEDAWCA-TEST",
  "Stan: Nowe",
  ...TAIL,
].join("\n");

/** A mail without images: the name on the line under the product link. */
export const AMAZON_UNDER_LINK_BODY = [
  ...HEAD,
  link("name"),
  AMAZON_NAME,
  "Sprzedawca SPRZEDAWCA-TEST",
  "Stan: Nowe",
  ...TAIL,
].join("\n");

/** The name only inside `[image: ...]`, nothing under the link. */
export const AMAZON_IMAGE_ONLY_BODY = [
  ...HEAD,
  `[image: ${AMAZON_NAME}]`,
  link("image"),
  "Sprzedawca SPRZEDAWCA-TEST",
  "Stan: Nowe",
  ...TAIL,
].join("\n");

/** Both, the line under the link with the full name: the item must be emitted once. */
export const AMAZON_BOTH_BODY = [
  ...HEAD,
  `[image: ${AMAZON_NAME}]`,
  link("image"),
  AMAZON_NAME,
  link("name"),
  "Sprzedawca SPRZEDAWCA-TEST",
  "Stan: Nowe",
  ...TAIL,
].join("\n");
