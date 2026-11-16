import { allegroMail } from "./allegro-mail";

/** One product, quantity 1: no "N × price" line, the amount follows the product. Synthetic ids and seller. */
export const ALLEGRO_A_ORDER_ID = "a0000000-0000-4000-8000-000000000001";
export const ALLEGRO_A_TITLE =
  "Szukacz Par Przewodów Kabli Sonda Tester MS6812R";
export const ALLEGRO_A_SUBJECT = `Kupiłeś i zapłaciłeś: ${ALLEGRO_A_TITLE}`;

export const ALLEGRO_A_BODY = allegroMail({
  orderId: ALLEGRO_A_ORDER_ID,
  seller: "sklep_testowy_a",
  title: ALLEGRO_A_TITLE,
  day: "23 sie 2026",
  products: [
    { name: ALLEGRO_A_TITLE, offerId: "18000000001", amount: "59,20" },
  ],
  total: "59,20",
  withoutSmart: "70,15",
});
