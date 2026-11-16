/**
 * The Allegro "Kupiłeś i zapłaciłeś" mail as Gmail's "Forward" leaves it in
 * the stored text: the forwarded-message header block (the Subject wrapped at
 * 76 columns), a pre-header of zero-width characters, tracking links on their
 * own lines, `[image: ...]` stand-ins, the bold `*...*` of Gmail, and Gmail's
 * own map link under an address.
 *
 * ANONYMISED from a real mail: every person, address, e-mail, phone, login,
 * payment number, order number and link query string is invented; the merchant
 * names, the product names, the amounts and the line structure are kept.
 */

export interface AllegroProduct {
  name: string;
  offerId: string;
  /** The line total, as written ("4,41"). */
  amount: string;
  /** "N × unit price" line, from the second unit on. */
  quantity?: { qty: number; unit: string };
}

export interface AllegroMailInput {
  /** The order number in the details link (invented). */
  orderId: string;
  seller: string;
  /** What the buyer sees after "Kupiłeś i zapłaciłeś:" in the subject. */
  title: string;
  products: AllegroProduct[];
  /** RAZEM, and the same basket priced without the Smart! package. */
  total: string;
  withoutSmart: string;
  /** The date of the order and when the payment was passed on. */
  day: string;
}

const ZERO_WIDTH = "‌ ".repeat(20).trimEnd();

/** Break a line at spaces so that none is wider than `width`, as Gmail does to prose and headers. */
export function hardWrap(text: string, width = 76): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  out.push(line);
  return out;
}

const link = (path: string, tag: string): string =>
  `<https://t.allegro.pl/${path}?utm_source=example&utm_medium=mail&tr_id=${tag}>`;

function productBlock(product: AllegroProduct): string[] {
  const offer = link(`oferta/${product.offerId}`, `offer-${product.offerId}`);
  return [
    product.name,
    offer,
    `(${product.offerId})`,
    offer,
    `${product.amount} zł`,
    ...(product.quantity
      ? [`${product.quantity.qty} × ${product.quantity.unit} zł`]
      : []),
  ];
}

export function allegroMail(input: AllegroMailInput): string {
  const details = link(
    `moje-allegro/zakupy/kupione/${input.orderId}`,
    "details",
  );
  const first = input.products[0].name;
  return [
    "---------- Forwarded message ---------",
    "Od: Allegro <powiadomienia@allegro.pl>",
    `Date: niedz., ${input.day} o 21:40`,
    ...hardWrap(`Subject: Kupiłeś i zapłaciłeś: ${input.title}`),
    "To: <alice.example@example.com>",
    "",
    `Alicjo, sprawdź szczegóły ${ZERO_WIDTH}`,
    ZERO_WIDTH,
    ZERO_WIDTH,
    "Masz dostępne *2 000,00 zł* w",
    link("metody-platnosci/allegro-pay", "pay-text"),
    "[image:",
    "pay]",
    link("metody-platnosci/allegro-pay", "pay-logo"),
    "[image: Allegro]",
    link("", "logo"),
    "Cześć Alicja,",
    ...hardWrap(`kupiłeś ${first}, a sprzedający`),
    input.seller,
    link(`uzytkownik/${input.seller}`, "seller-header"),
    "otrzymał Twoją wpłatę.",
    "Twój zakup: opłacony",
    `z dnia ${input.day}, 21:39`,
    `od ${input.seller}`,
    ...input.products.flatMap(productBlock),
    "Metoda dostawy",
    "Paczkomat InPost, ul. Przykładowa 1",
    "<https://www.google.com/maps/search/Przykladowa+1?entry=gmail&source=g>",
    "0,00 zł",
    "z pakietem [image: Smart!] 10,95 zł",
    "Przejdź do Szczegółów zakupu",
    details,
    "Masz wątpliwości? Zapytaj o zakup",
    details.replace("tr_id=details", "tr_id=ask"),
    "------------------------------",
    "RAZEM",
    `${input.total} zł`,
    `${input.withoutSmart} zł`,
    "Zapomniałeś o czymś?",
    "[image: ZESTAW PRECYZYJNYCH WKRĘTAKÓW 132 ELEMENTY",
    "BITY]",
    link("produkt/zestaw-wkretakow-example", "reco-1"),
    link("produkt/zestaw-wkretakow-example", "reco-1"),
    "[image: Turn on notifications]",
    link("app", "app-banner"),
    "Czekasz na przesyłkę?",
    "W apce Allegro, w sekcji Moje Przesyłki wygodnie sprawdzisz, kiedy u Ciebie",
    "będzie!",
    "Śledź przesyłkę z aplikacją",
    link("app", "app-link"),
    "Płatność",
    `${input.total} zł`,
    `przekazana ${input.day}, 21:39:55`,
    "Metoda płatności",
    "Google Pay",
    "Numer płatności",
    "00000000-0000-4000-8000-00000000a11e",
    "Dane odbiorcy przesyłki",
    "Alicja Testowa",
    "ul. Przykładowa 1, 00-001 Miasto",
    "<https://www.google.com/maps/search/Przykladowa+1,+00-001+Miasto?entry=gmail&source=g>",
    "+48000000000",
    "Dane sprzedającego",
    input.seller,
    link(`uzytkownik/${input.seller}`, "seller-payment"),
    "Sklep Testowy sp. z o.o.",
    "ul. Sprzedawcy 2, 00-002 Miasto",
    "<https://www.google.com/maps/search/Sprzedawcy+2,+00-002+Miasto?entry=gmail&source=g>",
    "+48 00 000 00 00 <+48%2000%20000%2000%2000>",
    "sprzedawca@allegromail.example",
    "Pozdrawiamy",
    "Allegro",
    "------------------------------",
    "Płatność realizowana w ramach usługi Allegro Finance. Od płatności nie",
    "pobieramy opłaty.",
    "Wiadomość wysłana przez Allegro do *Alicja Testowa (alicja_test)*.",
    "Przydatne informacje",
    "- Informacje o swoich zakupach znajdziesz w zakładce Moje zakupy",
    link("moje-allegro/zakupy/kupione", "dashboard"),
    ".",
    "--",
    "Alicja Testowa",
    "",
  ].join("\n");
}
