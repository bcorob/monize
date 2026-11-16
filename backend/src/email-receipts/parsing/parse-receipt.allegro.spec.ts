import { parseReceipt } from "./parse-receipt";
import { isStrictReceiptAmount } from "./receipt-amount";
import { matchReceiptPattern } from "./receipt-glob";
import {
  ALLEGRO_CATEGORY_GOODS,
  ALLEGRO_CATEGORY_SHIPPING,
  ALLEGRO_DEFINITION,
} from "./fixtures/allegro-definition";
import {
  ALLEGRO_A_BODY,
  ALLEGRO_A_ORDER_ID,
  ALLEGRO_A_SUBJECT,
} from "./fixtures/allegro-a-single";
import {
  ALLEGRO_B_BODY,
  ALLEGRO_B_ORDER_ID,
  ALLEGRO_B_SUBJECT,
} from "./fixtures/allegro-b-three-products";
import {
  ALLEGRO_C_BODY,
  ALLEGRO_C_ORDER_ID,
  ALLEGRO_C_SUBJECT,
} from "./fixtures/allegro-c-single";
import {
  ALLEGRO_D_BODY,
  ALLEGRO_D_ORDER_ID,
  ALLEGRO_D_PRODUCT_NAME,
  ALLEGRO_D_SUBJECT,
} from "./fixtures/allegro-d-single";
import { validateReceiptParserDefinition } from "./receipt-parser.validation";

/**
 * The Allegro "Kupiłeś i zapłaciłeś" mail (sender powiadomienia@allegro.pl):
 * name and amount never share a line, the total sits under the label "RAZEM"
 * and is followed by the same basket without the Smart! package, and the
 * delivery price is followed by the Smart! price. One definition reads all four
 * synthetic samples completely.
 */

const SMART_PRICE = 109500;

interface Sample {
  label: string;
  subject: string;
  body: string;
  orderId: string;
  total: number;
  /** The second amount under RAZEM: the basket without the Smart! package. */
  withoutSmart: number;
  items: { name: string; qty: number; amount: number }[];
}

const SAMPLES: Sample[] = [
  {
    label: "A: one product",
    subject: ALLEGRO_A_SUBJECT,
    body: ALLEGRO_A_BODY,
    orderId: ALLEGRO_A_ORDER_ID,
    total: 592000,
    withoutSmart: 701500,
    items: [
      {
        name: "Szukacz Par Przewodów Kabli Sonda Tester MS6812R",
        qty: 1,
        amount: 592000,
      },
    ],
  },
  {
    label: "B: three products",
    subject: ALLEGRO_B_SUBJECT,
    body: ALLEGRO_B_BODY,
    orderId: ALLEGRO_B_ORDER_ID,
    total: 623500,
    withoutSmart: 733000,
    items: [
      {
        name: "Patchcord kabel sieciowy Lanberg U/UTP 5e RJ45 / RJ45 0,25 m czerwony",
        qty: 3,
        amount: 44100,
      },
      {
        name: "Patchcord kabel sieciowy Lanberg U/UTP 6 RJ45 / RJ45 0,25 m żółty",
        qty: 3,
        amount: 75000,
      },
      {
        name: "Patchcord kabel sieciowy UTP 6 RJ45 0,25m czarny",
        qty: 26,
        amount: 504400,
      },
    ],
  },
  {
    label: "C: one product",
    subject: ALLEGRO_C_SUBJECT,
    body: ALLEGRO_C_BODY,
    orderId: ALLEGRO_C_ORDER_ID,
    total: 992100,
    withoutSmart: 1101600,
    items: [
      {
        name: "Czujka gazu ziemnego i LPG WiFi CGZ-02 ZAMEL TUYA wyświetlacz LCD",
        qty: 1,
        amount: 992100,
      },
    ],
  },
  {
    label: "D: one product with ' x 8szt.' in its name",
    subject: ALLEGRO_D_SUBJECT,
    body: ALLEGRO_D_BODY,
    orderId: ALLEGRO_D_ORDER_ID,
    total: 4000000,
    withoutSmart: 4109500,
    items: [{ name: ALLEGRO_D_PRODUCT_NAME, qty: 1, amount: 4000000 }],
  },
];

describe("the Allegro definition", () => {
  it("is a valid definition", () => {
    expect(validateReceiptParserDefinition(ALLEGRO_DEFINITION)).toEqual({
      ok: true,
      definition: ALLEGRO_DEFINITION,
    });
  });

  describe.each(SAMPLES)("sample $label", (sample) => {
    const parsed = parseReceipt(
      ALLEGRO_DEFINITION,
      sample.subject,
      sample.body,
      null,
    );

    it("reads the mail completely", () => {
      expect(parsed.complete).toBe(true);
      expect(parsed.reason).toBeNull();
    });

    it("reads the order number from the link", () => {
      expect(parsed.orderId).toBe(sample.orderId);
    });

    it("reads the total under RAZEM", () => {
      expect(parsed.total).toBe(sample.total);
    });

    it("reads every product with its quantity and line total, in goods' category", () => {
      expect(parsed.items).toEqual(
        sample.items.map((item) => ({
          ...item,
          categoryId: ALLEGRO_CATEGORY_GOODS,
        })),
      );
      expect(parsed.shippingCategoryId).toBe(ALLEGRO_CATEGORY_SHIPPING);
    });

    it("reads a delivery of 0,00, never the Smart! price", () => {
      expect(parsed.shipping).toBe(0);
      expect(parsed.shipping).not.toBe(SMART_PRICE);
      expect(parsed.discount).toBeNull();
    });

    it("never takes the Smart! price or the basket without Smart! for the total", () => {
      expect(parsed.total).not.toBe(SMART_PRICE);
      expect(parsed.total).not.toBe(sample.withoutSmart);
      expect(parsed.items.some((item) => item.amount === SMART_PRICE)).toBe(
        false,
      );
    });

    it("balances: the items add up to the total", () => {
      const sum = parsed.items.reduce((acc, item) => acc + item.amount, 0);
      expect(sum + (parsed.shipping ?? 0)).toBe(parsed.total);
    });
  });

  it("reads three products as three items, not as the first one's amount", () => {
    const parsed = parseReceipt(
      ALLEGRO_DEFINITION,
      ALLEGRO_B_SUBJECT,
      ALLEGRO_B_BODY,
      null,
    );
    expect(parsed.items).toHaveLength(3);
    expect(parsed.total).not.toBe(44100);
  });

  it("reads the same mail from CRLF line breaks and non-breaking spaces", () => {
    const body = ALLEGRO_B_BODY.replace(/\n/g, "\r\n").replace(
      / zł/g,
      "\xa0zł",
    );
    const parsed = parseReceipt(ALLEGRO_DEFINITION, "", body, null);
    expect(parsed.complete).toBe(true);
    expect(parsed.total).toBe(623500);
  });
});

describe("the product name of sample D", () => {
  it("is not an amount, though it ends in digits", () => {
    expect(isStrictReceiptAmount(ALLEGRO_D_PRODUCT_NAME)).toBe(false);
    expect(
      matchReceiptPattern(
        "{amount} zł",
        ALLEGRO_D_PRODUCT_NAME,
        (captures) =>
          captures.amount !== undefined &&
          isStrictReceiptAmount(captures.amount),
      ),
    ).toBeNull();
  });

  it("is not a quantity line: ' x ' is not the multiplication sign ' × '", () => {
    const quantityLine = "{qty} × {price} zł";
    expect(
      matchReceiptPattern(quantityLine, ALLEGRO_D_PRODUCT_NAME, () => true),
    ).toBeNull();
    expect(
      matchReceiptPattern(quantityLine, "3 × 1,47 zł", () => true),
    ).toEqual({ qty: "3", price: "1,47" });
  });

  it("stays one item of quantity 1 at 400,00", () => {
    const parsed = parseReceipt(
      ALLEGRO_DEFINITION,
      ALLEGRO_D_SUBJECT,
      ALLEGRO_D_BODY,
      null,
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].qty).toBe(1);
  });
});
