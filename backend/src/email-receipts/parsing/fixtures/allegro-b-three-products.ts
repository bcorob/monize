import { allegroMail } from "./allegro-mail";

/** Three products, each with its "N × unit price" line. Synthetic ids and seller. */
export const ALLEGRO_B_ORDER_ID = "b0000000-0000-4000-8000-000000000002";
export const ALLEGRO_B_TITLE =
  "Patchcord kabel sieciowy Lanberg U/UTP 5e RJ45 / RJ45 0,25 m czerwony";
export const ALLEGRO_B_SUBJECT = `Kupiłeś i zapłaciłeś: ${ALLEGRO_B_TITLE}`;

export const ALLEGRO_B_BODY = allegroMail({
  orderId: ALLEGRO_B_ORDER_ID,
  seller: "sklep_testowy_b",
  title: ALLEGRO_B_TITLE,
  day: "23 sie 2026",
  products: [
    {
      name: ALLEGRO_B_TITLE,
      offerId: "18770048324",
      amount: "4,41",
      quantity: { qty: 3, unit: "1,47" },
    },
    {
      name: "Patchcord kabel sieciowy Lanberg U/UTP 6 RJ45 / RJ45 0,25 m żółty",
      offerId: "18509517017",
      amount: "7,50",
      quantity: { qty: 3, unit: "2,50" },
    },
    {
      name: "Patchcord kabel sieciowy UTP 6 RJ45 0,25m czarny",
      offerId: "18509495272",
      amount: "50,44",
      quantity: { qty: 26, unit: "1,94" },
    },
  ],
  total: "62,35",
  withoutSmart: "73,30",
});
