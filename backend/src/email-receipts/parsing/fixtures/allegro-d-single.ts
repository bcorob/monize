import { allegroMail } from "./allegro-mail";

/**
 * One product whose NAME holds " x 8szt." (an ASCII x, not the U+00D7 of a
 * quantity line) and ends in digits. Synthetic ids and seller.
 */
export const ALLEGRO_D_ORDER_ID = "d0000000-0000-4000-8000-000000000004";
export const ALLEGRO_D_PRODUCT_NAME = "Akumulator AGM SSB 12V5Ah x 8szt. F1";
export const ALLEGRO_D_SUBJECT = `Kupiłeś i zapłaciłeś: ${ALLEGRO_D_PRODUCT_NAME}`;

export const ALLEGRO_D_BODY = allegroMail({
  orderId: ALLEGRO_D_ORDER_ID,
  seller: "sklep_testowy_d",
  title: ALLEGRO_D_PRODUCT_NAME,
  day: "25 sie 2026",
  products: [
    { name: ALLEGRO_D_PRODUCT_NAME, offerId: "18000000004", amount: "400,00" },
  ],
  total: "400,00",
  withoutSmart: "410,95",
});
