import { ValidationPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { CreateWarrantyDto } from "./create-warranty.dto";
import { ListWarrantiesDto } from "./list-warranties.dto";
import { UpdateWarrantyDto } from "./update-warranty.dto";

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

/** The properties a payload was refused on, sorted. */
function refusedOn(cls: new () => object, body: object): string[] {
  return validateSync(plainToInstance(cls, body), OPTIONS)
    .map((error) => error.property)
    .sort();
}

const base = { name: "Laptop", purchaseDate: "2026-10-01" };

describe("CreateWarrantyDto", () => {
  it.each([
    [{ expiresOn: "2028-10-01" }],
    [{ term: { years: 2 } }],
    [{ isLifetime: true }],
    [{ isLifetime: false, expiresOn: "2028-10-01" }],
  ])("accepts exactly one expiry source: %j", (source) => {
    expect(refusedOn(CreateWarrantyDto, { ...base, ...source })).toEqual([]);
  });

  it.each([
    [{}],
    [{ isLifetime: false }],
    [{ expiresOn: "", term: null }],
    [{ expiresOn: "2028-10-01", term: { years: 2 } }],
    [{ expiresOn: "2028-10-01", isLifetime: true }],
    [{ term: { months: 6 }, isLifetime: true }],
  ])("refuses zero or two expiry sources: %j", (source) => {
    expect(refusedOn(CreateWarrantyDto, { ...base, ...source })).toEqual([
      "expirySource",
    ]);
  });

  it("refuses an expiry before the purchase", () => {
    expect(
      refusedOn(CreateWarrantyDto, { ...base, expiresOn: "2026-09-30" }),
    ).toEqual(["expiryAfterPurchase"]);
  });

  it("accepts an expiry on the purchase day", () => {
    expect(
      refusedOn(CreateWarrantyDto, { ...base, expiresOn: "2026-10-01" }),
    ).toEqual([]);
  });

  it.each([
    [{ purchasePrice: 10 }],
    [{ currencyCode: "CAD" }],
    [{ purchasePrice: 10, currencyCode: "" }],
  ])("refuses a price without its currency, or the reverse: %j", (price) => {
    expect(
      refusedOn(CreateWarrantyDto, { ...base, isLifetime: true, ...price }),
    ).toEqual(["priceCurrency"]);
  });

  it("accepts a price with its currency, and neither", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        purchasePrice: 10.5,
        currencyCode: "CAD",
      }),
    ).toEqual([]);
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        purchasePrice: null,
        currencyCode: null,
      }),
    ).toEqual([]);
  });

  it("bounds serial numbers: ten of at most 100 characters", () => {
    const ok = Array.from({ length: 10 }, (_, i) => `SN-${i}`);
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        serialNumbers: ok,
      }),
    ).toEqual([]);
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        serialNumbers: [...ok, "SN-10"],
      }),
    ).toEqual(["serialNumbers"]);
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        serialNumbers: ["x".repeat(101)],
      }),
    ).toEqual(["serialNumbers"]);
  });

  it("refuses a null warranty kind, and takes an absent one as the default", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        warrantyKind: null,
      }),
    ).toEqual(["warrantyKind"]);
    expect(refusedOn(CreateWarrantyDto, { ...base, isLifetime: true })).toEqual(
      [],
    );
  });

  it("refuses a warranty kind outside the enum", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        warrantyKind: "lifetime",
      }),
    ).toEqual(["warrantyKind"]);
  });

  it("refuses a userId: the owner is the JWT's", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        userId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual(["userId"]);
  });

  it("refuses a client sending a rule's own name", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        expirySource: "anything",
      }),
    ).toEqual(["expirySource"]);
  });

  it("accepts blank optional formatted fields, so an untouched form saves", () => {
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        isLifetime: true,
        productUrl: "",
        payeeId: "",
        transactionId: null,
        currencyCode: "",
        expiresOn: "",
      }),
    ).toEqual([]);
  });

  it("wants a product URL with an http(s) protocol", () => {
    const withUrl = (productUrl: string) =>
      refusedOn(CreateWarrantyDto, { ...base, isLifetime: true, productUrl });
    expect(withUrl("https://example.com/laptop")).toEqual([]);
    expect(withUrl("example.com/laptop")).toEqual(["productUrl"]);
    expect(withUrl("javascript:alert(1)")).toEqual(["productUrl"]);
  });

  it("strips angle brackets from free text", () => {
    const dto = plainToInstance(CreateWarrantyDto, {
      ...base,
      name: "<b>Laptop</b>",
      notes: "<script>x</script>",
      serialNumbers: ["<SN>"],
    });
    expect(dto.name).toBe("bLaptop/b");
    expect(dto.notes).toBe("scriptx/script");
    expect(dto.serialNumbers).toEqual(["SN"]);
  });

  it("refuses a blank name and an impossible date", () => {
    expect(
      refusedOn(CreateWarrantyDto, { ...base, name: "   ", isLifetime: true }),
    ).toEqual(["name"]);
    expect(
      refusedOn(CreateWarrantyDto, {
        ...base,
        purchaseDate: "2026-02-30",
        isLifetime: true,
      }),
    ).toEqual(["purchaseDate"]);
  });

  it("bounds a term's parts", () => {
    expect(
      refusedOn(CreateWarrantyDto, { ...base, term: { years: -1 } }),
    ).toContain("term");
    expect(
      refusedOn(CreateWarrantyDto, { ...base, term: { months: 1.5 } }),
    ).toContain("term");
  });
});

describe("UpdateWarrantyDto", () => {
  it("accepts a payload naming no expiry source: the stored one stays", () => {
    expect(refusedOn(UpdateWarrantyDto, { name: "Renamed" })).toEqual([]);
    expect(refusedOn(UpdateWarrantyDto, {})).toEqual([]);
  });

  it("refuses two expiry sources", () => {
    expect(
      refusedOn(UpdateWarrantyDto, {
        expiresOn: "2028-10-01",
        isLifetime: true,
      }),
    ).toEqual(["expirySource"]);
  });

  it("keeps a price and its currency together when either is sent", () => {
    expect(refusedOn(UpdateWarrantyDto, { purchasePrice: 5 })).toEqual([
      "priceCurrency",
    ]);
    expect(
      refusedOn(UpdateWarrantyDto, { purchasePrice: 5, currencyCode: "USD" }),
    ).toEqual([]);
  });

  describe("null on PATCH, through the global ValidationPipe", () => {
    // main.ts's options, so a refusal here is the 400 the route returns.
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const patch = (body: object) =>
      pipe.transform(body, {
        type: "body",
        metatype: UpdateWarrantyDto,
      }) as Promise<UpdateWarrantyDto>;

    it.each([
      [{ name: null }, "name"],
      [{ warrantyKind: null }, "warrantyKind"],
      [{ purchaseDate: null }, "purchaseDate"],
    ])("refuses %j: the column is NOT NULL", async (body, property) => {
      await expect(patch(body)).rejects.toMatchObject({ status: 400 });
      expect(refusedOn(UpdateWarrantyDto, body)).toEqual([property]);
    });

    it.each([
      ["vendorName"],
      ["payeeId"],
      ["transactionId"],
      ["modelNumber"],
      ["productUrl"],
      ["notes"],
      ["expiresOn"],
    ])("accepts %s: null clears the nullable column", async (property) => {
      await expect(patch({ [property]: null })).resolves.toMatchObject({
        [property]: null,
      });
    });

    it("accepts a price and its currency cleared together", async () => {
      await expect(
        patch({ purchasePrice: null, currencyCode: null }),
      ).resolves.toMatchObject({ purchasePrice: null, currencyCode: null });
    });

    it("accepts a cleared expiry beside isLifetime: true", async () => {
      await expect(
        patch({ expiresOn: null, isLifetime: true }),
      ).resolves.toMatchObject({ expiresOn: null, isLifetime: true });
    });
  });
});

describe("ListWarrantiesDto", () => {
  it("accepts the documented filters", () => {
    expect(
      refusedOn(ListWarrantiesDto, {
        status: "expiring",
        q: "laptop",
        transactionId: "11111111-1111-4111-8111-111111111111",
        archived: "true",
        sort: "purchaseDate",
        page: "2",
        limit: "25",
      }),
    ).toEqual([]);
    const dto = plainToInstance(ListWarrantiesDto, {
      archived: "false",
      page: "2",
    });
    expect(dto.archived).toBe(false);
    expect(dto.page).toBe(2);
  });

  it.each([
    [{ status: "soon" }, "status"],
    [{ status: ["active", "expired"] }, "status"],
    [{ sort: "price" }, "sort"],
    [{ archived: "yes" }, "archived"],
    [{ limit: "500" }, "limit"],
    [{ q: ["a", "b"] }, "q"],
    [{ transactionId: "not-a-uuid" }, "transactionId"],
  ])("refuses %j", (query, property) => {
    expect(refusedOn(ListWarrantiesDto, query)).toEqual([property]);
  });
});
