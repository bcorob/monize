import {
  SCHEMA_ORG_MAX_DEPTH,
  SCHEMA_ORG_MAX_NODES,
  extractSchemaOrgOrder,
  isUsableSchemaOrgOrder,
  orderFromStructuredData,
  schemaOrgToParsedReceipt,
  type SchemaOrgOrder,
} from "./schema-org-order";

const ld = (json: unknown): string =>
  `<html><head><script type="application/ld+json">${
    typeof json === "string" ? json : JSON.stringify(json)
  }</script></head><body><p>Thanks</p></body></html>`;

/** Modelled on Google's Gmail "Order" markup reference example, with synthetic values. */
const GOOGLE_STYLE_ORDER = {
  "@context": "http://schema.org",
  "@type": "Order",
  merchant: { "@type": "Organization", name: "Example Shop" },
  orderNumber: "EX-123-4567",
  priceCurrency: "USD",
  price: "93.98",
  priceSpecification: {
    "@type": "PriceSpecification",
    validFrom: "2026-05-04T10:00:00-08:00",
  },
  acceptedOffer: [
    {
      "@type": "Offer",
      itemOffered: {
        "@type": "Product",
        name: "Streaming Dongle",
        sku: "SKU-1",
        url: "https://shop.example.com/p/1",
        image: "https://shop.example.com/i/1.png",
      },
      price: "35.00",
      priceCurrency: "USD",
      eligibleQuantity: { "@type": "QuantitativeValue", value: "2" },
    },
    {
      "@type": "Offer",
      itemOffered: { "@type": "Product", name: "Cable" },
      price: 23.98,
      priceCurrency: "USD",
      eligibleQuantity: { "@type": "QuantitativeValue", value: 1 },
    },
  ],
  url: "https://shop.example.com/orders/EX-123-4567",
  orderStatus: "http://schema.org/OrderProcessing",
  orderDate: "2026-05-04T10:00:00-08:00",
};

describe("extractSchemaOrgOrder: JSON-LD Order", () => {
  it("reads Google's Gmail Order example: merchant, number, total, offers with quantities", () => {
    expect(extractSchemaOrgOrder(ld(GOOGLE_STYLE_ORDER))).toEqual({
      orderNumber: "EX-123-4567",
      seller: "Example Shop",
      currency: "USD",
      orderDate: "2026-05-04T10:00:00-08:00",
      total: 939800,
      discount: null,
      items: [
        {
          name: "Streaming Dongle",
          qty: 2,
          unitPrice: 350000,
          amount: 700000,
        },
        { name: "Cable", qty: 1, unitPrice: 239800, amount: 239800 },
      ],
    });
  });

  it("reads a single offer object (not a list) and an offer with no quantity as 1", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        seller: { name: "S" },
        price: "10.00",
        acceptedOffer: {
          "@type": "Offer",
          itemOffered: { name: "One" },
          price: "10.00",
        },
      }),
    );
    expect(order?.items).toEqual([
      { name: "One", qty: 1, unitPrice: 100000, amount: 100000 },
    ]);
  });

  it("reads orderedItem as OrderItem with orderQuantity and a Product", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        orderNumber: 1234567,
        totalPrice: 30,
        orderedItem: [
          {
            "@type": "OrderItem",
            orderQuantity: 3,
            orderedItem: {
              "@type": "Product",
              name: "Pen",
              offers: { "@type": "Offer", price: "10.00" },
            },
          },
        ],
      }),
    );
    expect(order).toEqual(
      expect.objectContaining({
        orderNumber: "1234567",
        total: 300000,
        items: [{ name: "Pen", qty: 3, unitPrice: 100000, amount: 300000 }],
      }),
    );
  });

  it("reads an orderedItem that is a Product directly, and one that is plain text", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        price: 5,
        orderedItem: [
          { "@type": "Product", name: "Direct", price: "2.50" },
          "Text only",
        ],
      }),
    );
    expect(order?.items).toEqual([
      { name: "Direct", qty: 1, unitPrice: 25000, amount: 25000 },
      { name: "Text only", qty: 1, unitPrice: null, amount: null },
    ]);
  });

  it("prefers acceptedOffer over orderedItem so a doubled listing is not counted twice", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        price: "4.00",
        acceptedOffer: [{ itemOffered: { name: "A" }, price: "4.00" }],
        orderedItem: [{ orderedItem: { name: "A" }, price: "4.00" }],
      }),
    );
    expect(order?.items).toHaveLength(1);
  });

  it("reads the discount", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        price: "8.00",
        discount: 2,
        acceptedOffer: [{ itemOffered: { name: "A" }, price: "10.00" }],
      }),
    );
    expect(order?.discount).toBe(20000);
  });

  it("takes the seller from seller, merchant, provider or broker, in that order", () => {
    const sellerOf = (props: Record<string, unknown>) =>
      extractSchemaOrgOrder(
        ld({ "@type": "Order", orderNumber: "X-1", ...props }),
      )?.seller;
    expect(sellerOf({ seller: { name: "S" }, merchant: { name: "M" } })).toBe(
      "S",
    );
    expect(sellerOf({ merchant: { name: "M" }, provider: { name: "P" } })).toBe(
      "M",
    );
    expect(sellerOf({ provider: { name: "P" }, broker: { name: "B" } })).toBe(
      "P",
    );
    expect(sellerOf({ broker: { name: "B" } })).toBe("B");
    expect(sellerOf({ seller: "Plain Name" })).toBe("Plain Name");
    expect(
      sellerOf({
        seller: { "@type": "Organization" },
        merchant: { name: "M" },
      }),
    ).toBe("M");
    expect(sellerOf({})).toBeNull();
  });
});

describe("extractSchemaOrgOrder: Invoice, @graph, type forms", () => {
  it("reads an Invoice: confirmationNumber, provider, totalPaymentDue", () => {
    const invoice = {
      "@context": "https://schema.org",
      "@type": "Invoice",
      confirmationNumber: "INV-2026-0007",
      provider: { "@type": "Organization", name: "Example Utilities" },
      totalPaymentDue: {
        "@type": "PriceSpecification",
        price: "42.10",
        priceCurrency: "EUR",
      },
      acceptedOffer: [{ itemOffered: { name: "Electricity" }, price: "42.10" }],
    };
    expect(extractSchemaOrgOrder(ld(invoice))).toEqual({
      orderNumber: "INV-2026-0007",
      seller: "Example Utilities",
      currency: "EUR",
      orderDate: null,
      total: 421000,
      discount: null,
      items: [
        { name: "Electricity", qty: 1, unitPrice: 421000, amount: 421000 },
      ],
    });
  });

  it("reads totalPaymentDue as a MonetaryAmount value and priceSpecification.price as total", () => {
    const total = (props: Record<string, unknown>) =>
      extractSchemaOrgOrder(
        ld({ "@type": "Order", orderNumber: "N-1", ...props }),
      )?.total;
    expect(total({ totalPaymentDue: { value: 12.5 } })).toBe(125000);
    expect(total({ priceSpecification: { price: "7.00" } })).toBe(70000);
    expect(total({ totalPrice: "3" })).toBe(30000);
  });

  it("finds an Order inside @graph", () => {
    const doc = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Example Shop" },
        { "@type": "Organization", name: "Example Shop" },
        { ...GOOGLE_STYLE_ORDER, "@context": undefined },
      ],
    };
    expect(extractSchemaOrgOrder(ld(doc))?.orderNumber).toBe("EX-123-4567");
  });

  it("finds an Order in a top-level array and nested under another node", () => {
    expect(
      extractSchemaOrgOrder(
        ld([{ "@type": "EmailMessage" }, GOOGLE_STYLE_ORDER]),
      )?.orderNumber,
    ).toBe("EX-123-4567");
    expect(
      extractSchemaOrgOrder(
        ld({ "@type": "EmailMessage", about: GOOGLE_STYLE_ORDER }),
      )?.orderNumber,
    ).toBe("EX-123-4567");
  });

  it("accepts a type array and the prefixed forms", () => {
    for (const type of [
      ["Thing", "Order"],
      "https://schema.org/Order",
      "http://schema.org/Order",
      "schema:Order",
      ["schema:Invoice"],
    ]) {
      expect(
        extractSchemaOrgOrder(
          ld({ "@type": type, orderNumber: "T-1", price: "1.00" }),
        )?.orderNumber,
      ).toBe("T-1");
    }
  });

  it("ignores other types, including ones that merely start with Order", () => {
    for (const type of [
      "OrderItem",
      "OrderAction",
      "OrderStatus",
      "ParcelDelivery",
      "Product",
      "order",
      "Reservation",
      ["OrderItem", "Thing"],
    ]) {
      expect(
        extractSchemaOrgOrder(
          ld({ "@type": type, orderNumber: "T-1", price: "1.00" }),
        ),
      ).toBeNull();
    }
  });

  it("skips an Order with nothing in it and takes the next one", () => {
    const html = ld([
      { "@type": "Order" },
      { "@type": "Order", orderNumber: "R-9", price: "1.00" },
    ]);
    expect(extractSchemaOrgOrder(html)?.orderNumber).toBe("R-9");
    expect(extractSchemaOrgOrder(ld({ "@type": "Order" }))).toBeNull();
  });

  it("prefers a reading with a total and a line over one without, wherever it sits", () => {
    const html =
      ld({ "@type": "Order", orderNumber: "PARTIAL-1" }) +
      ld({
        "@type": "Order",
        orderNumber: "FULL-1",
        price: "1.00",
        acceptedOffer: [{ itemOffered: { name: "A" }, price: "1.00" }],
      });
    expect(extractSchemaOrgOrder(html)?.orderNumber).toBe("FULL-1");
    expect(
      extractSchemaOrgOrder(ld({ "@type": "Order", orderNumber: "PARTIAL-1" }))
        ?.orderNumber,
    ).toBe("PARTIAL-1");
  });
});

describe("extractSchemaOrgOrder: prices are machine numbers", () => {
  const priceOf = (price: unknown) =>
    extractSchemaOrgOrder(ld({ "@type": "Order", orderNumber: "P-1", price }))
      ?.total ?? null;

  it("converts a string and a number to the same units", () => {
    expect(priceOf("24.99")).toBe(249900);
    expect(priceOf(24.99)).toBe(249900);
    expect(priceOf("24")).toBe(240000);
    expect(priceOf(0)).toBe(0);
    expect(priceOf("0.00")).toBe(0);
    expect(priceOf(" 7.5 ")).toBe(75000);
    expect(priceOf(19.9)).toBe(199000);
    expect(priceOf(1.005)).toBe(10050);
  });

  it("rounds a fifth fraction digit half up and ignores the rest", () => {
    expect(priceOf("1.00005")).toBe(10001);
    expect(priceOf("1.00004")).toBe(10000);
    expect(priceOf("0.12345678")).toBe(1235);
  });

  it("refuses the Polish grammar, thousands separators, symbols and signs", () => {
    for (const bad of [
      "24,99",
      "1 234,56 zł",
      "1,234.56",
      "$24.99",
      "24.99 USD",
      "-5.00",
      "+5.00",
      "1e3",
      ".5",
      "5.",
      "",
      " ",
      "abc",
      "0x10",
    ]) {
      expect(priceOf(bad)).toBeNull();
    }
  });

  it("refuses a negative, a non-finite, a huge or a non-scalar price", () => {
    for (const bad of [
      -1,
      -0.01,
      1e12,
      "123456789012",
      null,
      true,
      [],
      {},
      [{}],
    ]) {
      expect(priceOf(bad)).toBeNull();
    }
    expect(priceOf(Number.NaN)).toBeNull();
  });

  it("reads a list of one price and a {@value} price", () => {
    expect(priceOf(["3.00"])).toBe(30000);
    expect(priceOf({ "@value": "3.00" })).toBe(30000);
  });

  it("makes the line amount unit price times quantity, and leaves it null without a unit price", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        price: "30.00",
        acceptedOffer: [
          {
            itemOffered: { name: "A" },
            price: "0.10",
            eligibleQuantity: { value: 3 },
          },
          { itemOffered: { name: "B" } },
        ],
      }),
    );
    expect(order?.items).toEqual([
      { name: "A", qty: 3, unitPrice: 1000, amount: 3000 },
      { name: "B", qty: 1, unitPrice: null, amount: null },
    ]);
  });

  it("reads a quantity only when it is a whole number from 1 to 9999", () => {
    const qty = (value: unknown) =>
      extractSchemaOrgOrder(
        ld({
          "@type": "Order",
          price: 1,
          acceptedOffer: [
            {
              itemOffered: { name: "A" },
              price: "1.00",
              eligibleQuantity: { value },
            },
          ],
        }),
      )?.items[0].qty;
    expect(qty("4")).toBe(4);
    expect(qty(4)).toBe(4);
    expect(qty(9999)).toBe(9999);
    for (const bad of [0, -1, 1.5, "1.5", 10000, "abc", null, {}]) {
      expect(qty(bad)).toBe(1);
    }
  });
});

describe("extractSchemaOrgOrder: bad and hostile data", () => {
  it("ignores malformed JSON and a script that is not an object", () => {
    expect(extractSchemaOrgOrder(ld("{not json"))).toBeNull();
    expect(extractSchemaOrgOrder(ld('{"@type":"Order",'))).toBeNull();
    expect(extractSchemaOrgOrder(ld("42"))).toBeNull();
    expect(extractSchemaOrgOrder(ld("null"))).toBeNull();
    expect(extractSchemaOrgOrder(ld('"Order"'))).toBeNull();
  });

  it("keeps reading after a malformed script", () => {
    const html = ld("{broken") + ld(GOOGLE_STYLE_ORDER);
    expect(extractSchemaOrgOrder(html)?.orderNumber).toBe("EX-123-4567");
  });

  it("ignores a script of another type and a page with no markup", () => {
    expect(
      extractSchemaOrgOrder(
        `<script type="application/json">${JSON.stringify(GOOGLE_STYLE_ORDER)}</script>`,
      ),
    ).toBeNull();
    expect(extractSchemaOrgOrder("<p>No markup</p>")).toBeNull();
    expect(extractSchemaOrgOrder("")).toBeNull();
  });

  it("tolerates a byte order mark", () => {
    expect(
      orderFromStructuredData({
        jsonLd: ["﻿" + JSON.stringify(GOOGLE_STYLE_ORDER)],
        microdata: [],
      })?.orderNumber,
    ).toBe("EX-123-4567");
  });

  it("does not walk deeper than the depth cap", () => {
    const wrap = (depth: number): unknown => {
      let node: unknown = {
        "@type": "Order",
        orderNumber: "DEEP",
        price: "1.00",
      };
      for (let i = 0; i < depth; i++) node = { child: node };
      return node;
    };
    expect(
      extractSchemaOrgOrder(ld(wrap(SCHEMA_ORG_MAX_DEPTH)))?.orderNumber,
    ).toBe("DEEP");
    expect(
      extractSchemaOrgOrder(ld(wrap(SCHEMA_ORG_MAX_DEPTH + 1))),
    ).toBeNull();
  });

  it("survives JSON nested far deeper than any cap", () => {
    const deep = "[".repeat(20_000) + "]".repeat(20_000);
    expect(() => extractSchemaOrgOrder(ld(deep))).not.toThrow();
    expect(extractSchemaOrgOrder(ld(deep))).toBeNull();
  });

  it("does not walk more than the node cap", () => {
    const filler = Array.from(
      { length: SCHEMA_ORG_MAX_NODES + 10 },
      () => ({}),
    );
    const late = ld([
      ...filler,
      { "@type": "Order", orderNumber: "LATE", price: "1.00" },
    ]);
    expect(extractSchemaOrgOrder(late)).toBeNull();
    const early = ld([
      { "@type": "Order", orderNumber: "EARLY", price: "1.00" },
      ...filler,
    ]);
    expect(extractSchemaOrgOrder(early)?.orderNumber).toBe("EARLY");
  });

  it("caps the lines at 100 and the text fields", () => {
    const offers = Array.from({ length: 150 }, (_, i) => ({
      itemOffered: { name: `Item ${i}` },
      price: "1.00",
    }));
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        orderNumber: "N".repeat(500),
        merchant: { name: "M".repeat(500) },
        price: "1.00",
        acceptedOffer: offers,
      }),
    );
    expect(order?.items).toHaveLength(100);
    expect(order?.orderNumber).toHaveLength(100);
    expect(order?.seller).toHaveLength(200);
  });

  it("reads properties by their own names only (no prototype lookups)", () => {
    const order = extractSchemaOrgOrder(
      ld(
        '{"@type":"Order","orderNumber":"PROTO-1","price":"1.00","__proto__":{"seller":{"name":"Evil"}},"constructor":{"name":"Evil"}}',
      ),
    );
    expect(order?.seller).toBeNull();
    expect(order?.orderNumber).toBe("PROTO-1");
  });

  it("drops an item that names nothing and normalises names", () => {
    const order = extractSchemaOrgOrder(
      ld({
        "@type": "Order",
        price: "3.00",
        acceptedOffer: [
          { price: "1.00" },
          { itemOffered: { name: "  Two\n  lines  " }, price: "1.00" },
          { itemOffered: { name: "" }, price: "1.00" },
        ],
      }),
    );
    expect(order?.items.map((i) => i.name)).toEqual(["Two lines"]);
  });

  it("only takes a three-letter currency code", () => {
    const currency = (code: unknown) =>
      extractSchemaOrgOrder(
        ld({ "@type": "Order", orderNumber: "C-1", priceCurrency: code }),
      )?.currency;
    expect(currency("pln")).toBe("PLN");
    expect(currency("EURO")).toBeNull();
    expect(currency("€")).toBeNull();
    expect(currency(5)).toBeNull();
  });
});

describe("extractSchemaOrgOrder: microdata", () => {
  const MICRODATA = `
    <div itemscope itemtype="http://schema.org/Order">
      <div itemprop="merchant" itemscope itemtype="http://schema.org/Organization">
        <meta itemprop="name" content="Example Shop">
      </div>
      <meta itemprop="orderNumber" content="MD-2026-1">
      <meta itemprop="priceCurrency" content="PLN">
      <meta itemprop="price" content="59.97">
      <time itemprop="orderDate" datetime="2026-05-04">4 May</time>
      <div itemprop="acceptedOffer" itemscope itemtype="http://schema.org/Offer">
        <div itemprop="itemOffered" itemscope itemtype="http://schema.org/Product">
          <span itemprop="name">Notebook</span>
        </div>
        <meta itemprop="price" content="9.99">
        <div itemprop="eligibleQuantity" itemscope itemtype="http://schema.org/QuantitativeValue">
          <meta itemprop="value" content="3">
        </div>
      </div>
      <div itemprop="orderedItem" itemscope itemtype="http://schema.org/OrderItem">
        <meta itemprop="orderQuantity" content="1">
        <div itemprop="orderedItem" itemscope itemtype="http://schema.org/Product">
          <span itemprop="name">Pencil</span>
        </div>
      </div>
    </div>`;

  it("builds the order from the item tree, nested items included", () => {
    expect(extractSchemaOrgOrder(MICRODATA)).toEqual({
      orderNumber: "MD-2026-1",
      seller: "Example Shop",
      currency: "PLN",
      orderDate: "2026-05-04",
      total: 599700,
      discount: null,
      items: [{ name: "Notebook", qty: 3, unitPrice: 99900, amount: 299700 }],
    });
  });

  it("reads orderedItem of a microdata Order when there is no acceptedOffer", () => {
    const html = `
      <table itemscope itemtype="https://schema.org/Order">
        <tr><td itemprop="orderNumber">MD-7</td></tr>
        <tr><td><meta itemprop="price" content="12.00"></td></tr>
        <tr itemprop="orderedItem" itemscope itemtype="https://schema.org/OrderItem">
          <td itemprop="orderQuantity">2</td>
          <td itemprop="orderedItem" itemscope itemtype="https://schema.org/Product">
            <span itemprop="name">Mug</span>
            <span itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="6.00"></span>
          </td>
        </tr>
      </table>`;
    expect(extractSchemaOrgOrder(html)).toEqual(
      expect.objectContaining({
        orderNumber: "MD-7",
        total: 120000,
        items: [{ name: "Mug", qty: 2, unitPrice: 60000, amount: 120000 }],
      }),
    );
  });

  it("ignores a microdata item that is not an Order or an Invoice", () => {
    expect(
      extractSchemaOrgOrder(
        '<div itemscope itemtype="http://schema.org/Product"><meta itemprop="price" content="1"></div>',
      ),
    ).toBeNull();
  });

  it("reads an Invoice, and a type with the prefix variants", () => {
    const html =
      '<div itemscope itemtype="schema.org/Invoice"><meta itemprop="confirmationNumber" content="I-1">' +
      '<div itemprop="totalPaymentDue" itemscope><meta itemprop="price" content="3.00"></div></div>';
    expect(extractSchemaOrgOrder(html)).toEqual(
      expect.objectContaining({ orderNumber: "I-1", total: 30000 }),
    );
  });

  it("prefers JSON-LD when both are present and usable", () => {
    const html =
      ld({
        "@type": "Order",
        orderNumber: "LD-1",
        price: "1.00",
        acceptedOffer: [{ itemOffered: { name: "A" }, price: "1.00" }],
      }) + MICRODATA;
    expect(extractSchemaOrgOrder(html)?.orderNumber).toBe("LD-1");
  });

  it("does not let a microdata property named __proto__ change what is read", () => {
    const html =
      '<div itemscope itemtype="http://schema.org/Order"><meta itemprop="orderNumber" content="MP-1">' +
      '<div itemprop="__proto__" itemscope><meta itemprop="name" content="Evil"></div>' +
      '<div itemprop="merchant" itemscope><meta itemprop="name" content="Real"></div></div>';
    expect(extractSchemaOrgOrder(html)).toEqual(
      expect.objectContaining({ orderNumber: "MP-1", seller: "Real" }),
    );
  });
});

describe("isUsableSchemaOrgOrder and schemaOrgToParsedReceipt", () => {
  const order = (over: Partial<SchemaOrgOrder> = {}): SchemaOrgOrder => ({
    orderNumber: "A-1",
    seller: "Example Shop",
    currency: "USD",
    orderDate: null,
    total: 379700,
    discount: null,
    items: [
      { name: "Cable", qty: 2, unitPrice: 99900, amount: 199800 },
      { name: "Case", qty: 1, unitPrice: 150000, amount: 150000 },
    ],
    ...over,
  });
  const CAT = "11111111-1111-4111-8111-111111111111";

  it("is usable with a total and at least one item, and not otherwise", () => {
    expect(isUsableSchemaOrgOrder(order())).toBe(true);
    expect(isUsableSchemaOrgOrder(order({ total: null }))).toBe(false);
    expect(isUsableSchemaOrgOrder(order({ items: [] }))).toBe(false);
    expect(isUsableSchemaOrgOrder(order({ total: 0 }))).toBe(true);
  });

  it("builds a complete receipt when the lines make the total and each has the payee's category", () => {
    expect(schemaOrgToParsedReceipt(order({ total: 349800 }), CAT)).toEqual({
      orderId: "A-1",
      total: 349800,
      paid: null,
      payee: "Example Shop",
      shipping: null,
      discount: null,
      items: [
        { name: "Cable", qty: 2, amount: 199800, categoryId: CAT },
        { name: "Case", qty: 1, amount: 150000, categoryId: CAT },
      ],
      shippingCategoryId: null,
      discountCategoryId: CAT,
      complete: true,
      reason: null,
      source: "schema_org",
    });
  });

  it("is incomplete without a category (items_uncategorized), never complete by default", () => {
    const parsed = schemaOrgToParsedReceipt(order({ total: 349800 }), null);
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("items_uncategorized");
    expect(parsed.source).toBe("schema_org");
  });

  it("judges the arithmetic with the parser's table: a discount, net or gross, and unbalanced", () => {
    // gross 349800, net 329800.
    expect(
      schemaOrgToParsedReceipt(order({ total: 329800, discount: 20000 }), CAT)
        .complete,
    ).toBe(true);
    expect(
      schemaOrgToParsedReceipt(order({ total: 349800, discount: 20000 }), CAT)
        .complete,
    ).toBe(true);
    expect(schemaOrgToParsedReceipt(order({ total: 379700 }), CAT).reason).toBe(
      "items_unbalanced",
    );
  });

  it("gives the only line without a unit price the order total, but not one of several", () => {
    const single = schemaOrgToParsedReceipt(
      order({
        total: 100000,
        items: [{ name: "Gift", qty: 1, unitPrice: null, amount: null }],
      }),
      CAT,
    );
    expect(single.complete).toBe(true);
    expect(single.items).toEqual([
      { name: "Gift", qty: 1, amount: 100000, categoryId: CAT },
    ]);

    const several = schemaOrgToParsedReceipt(
      order({
        total: 300000,
        items: [
          { name: "A", qty: 1, unitPrice: 100000, amount: 100000 },
          { name: "B", qty: 1, unitPrice: null, amount: null },
        ],
      }),
      CAT,
    );
    expect(several.complete).toBe(false);
    expect(several.reason).toBe("item_amount_missing");
  });
});
