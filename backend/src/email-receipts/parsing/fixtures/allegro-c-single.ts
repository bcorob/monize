import { allegroMail } from "./allegro-mail";

/** One product, quantity 1. Synthetic ids and seller. */
export const ALLEGRO_C_ORDER_ID = "c0000000-0000-4000-8000-000000000003";
export const ALLEGRO_C_TITLE =
  "Czujka gazu ziemnego i LPG WiFi CGZ-02 ZAMEL TUYA wyświetlacz LCD";
export const ALLEGRO_C_SUBJECT = `Kupiłeś i zapłaciłeś: ${ALLEGRO_C_TITLE}`;

export const ALLEGRO_C_BODY = allegroMail({
  orderId: ALLEGRO_C_ORDER_ID,
  seller: "sklep_testowy_c",
  title: ALLEGRO_C_TITLE,
  day: "24 sie 2026",
  products: [
    { name: ALLEGRO_C_TITLE, offerId: "18000000003", amount: "99,21" },
  ],
  total: "99,21",
  withoutSmart: "110,16",
});
