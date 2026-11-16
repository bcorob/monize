import { ReceiptSourceLines } from "./receipt-source-lines";
import { readSchemaOrgReceipt } from "./schema-org-reading";

const page = (order: Record<string, unknown>): ReceiptSourceLines =>
  new ReceiptSourceLines({
    bodyText: "",
    bodyHtml: `<script type="application/ld+json">${JSON.stringify({
      "@type": "Order",
      ...order,
    })}</script>`,
  });

const ORDER = {
  merchant: { name: "Example Shop" },
  orderNumber: "A-1",
  price: "10.00",
  acceptedOffer: [{ itemOffered: { name: "Widget" }, price: "10.00" }],
};

describe("readSchemaOrgReceipt", () => {
  it("builds the receipt with the seller payee's default category on every line", async () => {
    const resolve = jest.fn(async () => ({ defaultCategoryId: "cat-1" }));
    const parsed = await readSchemaOrgReceipt(page(ORDER), resolve);
    expect(resolve).toHaveBeenCalledWith("Example Shop");
    expect(parsed).toMatchObject({
      source: "schema_org",
      complete: true,
      items: [{ name: "Widget", categoryId: "cat-1" }],
    });
  });

  it("leaves the lines uncategorised when the seller resolves to no payee, or one with no default", async () => {
    for (const payee of [null, { defaultCategoryId: null }]) {
      const parsed = await readSchemaOrgReceipt(page(ORDER), async () => payee);
      expect(parsed).toMatchObject({
        complete: false,
        reason: "items_uncategorized",
      });
    }
  });

  it("does not look a seller up when the order names none", async () => {
    const resolve = jest.fn(async () => null);
    const { merchant: _merchant, ...anonymous } = ORDER;
    await readSchemaOrgReceipt(page(anonymous), resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("is null, and looks nothing up, without an HTML part, markup, a total or a line", async () => {
    const resolve = jest.fn(async () => null);
    expect(
      await readSchemaOrgReceipt(
        new ReceiptSourceLines({ bodyText: "x", bodyHtml: null }),
        resolve,
      ),
    ).toBeNull();
    expect(
      await readSchemaOrgReceipt(
        new ReceiptSourceLines({ bodyText: "", bodyHtml: "<p>hi</p>" }),
        resolve,
      ),
    ).toBeNull();
    expect(
      await readSchemaOrgReceipt(page({ ...ORDER, price: undefined }), resolve),
    ).toBeNull();
    expect(
      await readSchemaOrgReceipt(
        page({ ...ORDER, acceptedOffer: [] }),
        resolve,
      ),
    ).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
