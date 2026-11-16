/**
 * Google Play order confirmations as Gmail's "Forward" leaves them: the
 * forwarded-message header block, the logo as `[image: ...]` with its tracking
 * link on its own line, the order number and date between literal asterisks,
 * the product line with its developer in parentheses and the price last (wrapped
 * at 76 columns when long), "Razem", a VAT note, the promotion text whose
 * amount ends its last line, and the card line.
 *
 * ANONYMISED from a real mail: the recipient, the card digits and every link
 * token are invented; the order numbers, the product names and the amounts are
 * the acceptance table's, the line structure is the real one.
 */
export const GOOGLE_1_NAME = "Hot Package 5 (Last War:Survival Game)";
export const GOOGLE_1_ORDER_ID = "GPA.3350-8103-9062-49114";
export const GOOGLE_1_SUBJECT =
  "Potwierdzenie zamówienia w Google Play z 14 wrz 2026";

const HEAD = (day: string, orderId: string): string[] => [
  "---------- Forwarded message ---------",
  "Od: Google Play <googleplay-noreply@google.com>",
  `Date: sob., ${day} o 10:42`,
  `Subject: Potwierdzenie zamówienia w Google Play z ${day}`,
  "To: <alice.example@example.com>",
  "",
  "[image: Google Play]",
  "<https://notifications.google.com/g/p/EXAMPLE-LOGO-TOKEN>",
  "Dziękujemy",
  "Kupiłeś(aś) produkt od sprzedawcy Google Commerce Limited w Google Play.",
  "",
  `* Numer zamówienia: * ${orderId}`,
  `* Data zamówienia: * ${day} 10:42:20 CEST`,
  "Produkt Cena",
];

const TAIL: string[] = [
  "* Zdobyte punkty Play *",
  "+22",
  "Google Commerce Limited",
  "Example House",
  "Sample Street",
  "Dublin 4",
  "Ireland",
  "*Prawo do odstąpienia od umowy:* zanim udostępniliśmy Ci treści cyfrowe,",
  "otrzymaliśmy od Ciebie potwierdzenie, że jednoznacznie zgadzasz się na",
  "zrzeczenie się prawa do odstąpienia od umowy.",
  "*Zwroty środków:* jeśli kupiony produkt nie działa poprawnie lub nie zgadza",
  "się z opisem w Google Play, możesz poprosić o zwrot środków na stronie",
  "Google Play",
  "<https://notifications.google.com/g/p/EXAMPLE-REFUND-TOKEN>",
  "Potrzebujesz pomocy? Odwiedź Centrum pomocy Google Play",
  "<https://notifications.google.com/g/p/EXAMPLE-HELP-TOKEN>",
  "Nie odpowiadaj na tę wiadomość.",
  "© 2026 Google | Wszelkie prawa zastrzeżone.",
  "--",
  "Alicja Testowa",
  "",
];

/** Receipt 1: a promotion. Razem 24,99 (the list price), 3,00 off, 21,99 charged to the card. */
export const GOOGLE_1_LINES: string[] = [
  ...HEAD("14 wrz 2026", GOOGLE_1_ORDER_ID),
  `${GOOGLE_1_NAME} (deweloper: First Fun) 24,99 zł`,
  "Razem: 24,99 zł",
  "(Zawiera VAT w kwocie 4,67 zł)",
  "*Oferta: 3 zł zniżki w Google Play na aplikację, grę lub zakup produktu",
  "w aplikacji* -3,00 zł",
  "Forma płatności:",
  "Visa-1234: 21,99 zł",
  ...TAIL,
];
export const GOOGLE_1_BODY = GOOGLE_1_LINES.join("\n");

/** Receipt 1 as a narrow client would wrap it: the product line over two lines. */
export const GOOGLE_1_WRAPPED_BODY = GOOGLE_1_BODY.replace(
  `${GOOGLE_1_NAME} (deweloper: First Fun) 24,99 zł`,
  `${GOOGLE_1_NAME} (deweloper:\nFirst Fun) 24,99 zł`,
);

export const GOOGLE_2_NAME =
  "Pro Upgrade (In-App Upgrade of Free Version) (ImageMeter - photo measure)";
export const GOOGLE_2_ORDER_ID = "GPA.3379-7620-5819-94397";

/** Receipt 2: no promotion and no card line; the product line wraps over three lines. */
export const GOOGLE_2_BODY = [
  ...HEAD("19 wrz 2026", GOOGLE_2_ORDER_ID),
  GOOGLE_2_NAME,
  "(deweloper: Example Studio Software Development Limited Liability",
  "Company) 44,99 zł",
  "Razem: 44,99 zł",
  "(Zawiera VAT w kwocie 8,41 zł)",
  "Forma płatności:",
  "Saldo Google Play",
  ...TAIL,
].join("\n");
