import {
  normalizeQuoteCurrency,
  verifyProviderCurrency,
} from "./quote-currency.util";

describe("normalizeQuoteCurrency", () => {
  it("maps the LSE pence quote unit onto pounds, in either spelling", () => {
    expect(normalizeQuoteCurrency("GBp")).toBe("GBP");
    expect(normalizeQuoteCurrency("GBX")).toBe("GBP");
    expect(normalizeQuoteCurrency("gbx")).toBe("GBP");
  });

  it("is idempotent, so an already normalized code is not converted twice", () => {
    const once = normalizeQuoteCurrency("GBp");
    expect(normalizeQuoteCurrency(once)).toBe("GBP");
  });

  it("trims and upper-cases, and reads blank as absent", () => {
    expect(normalizeQuoteCurrency(" usd ")).toBe("USD");
    expect(normalizeQuoteCurrency("")).toBeNull();
    expect(normalizeQuoteCurrency("   ")).toBeNull();
    expect(normalizeQuoteCurrency(null)).toBeNull();
    expect(normalizeQuoteCurrency(undefined)).toBeNull();
  });
});

describe("verifyProviderCurrency", () => {
  it("refuses a GBP listing for a security configured in USD", () => {
    expect(verifyProviderCurrency("USD", "GBP")).toEqual({
      accepted: false,
      configured: "USD",
      reported: "GBP",
    });
  });

  it("refuses the pence spelling of a mismatch too, after normalizing it once", () => {
    expect(verifyProviderCurrency("USD", "GBp")).toEqual({
      accepted: false,
      configured: "USD",
      reported: "GBP",
    });
  });

  it("accepts GBX for a GBP security, as one currency in two units", () => {
    expect(verifyProviderCurrency("GBP", "GBp")).toEqual({
      accepted: true,
      verified: true,
      currency: "GBP",
    });
  });

  it("accepts a matching code regardless of case or padding", () => {
    expect(verifyProviderCurrency("usd", " USD ")).toEqual({
      accepted: true,
      verified: true,
      currency: "USD",
    });
  });

  it("accepts a silent provider as unverified rather than refusing it", () => {
    expect(verifyProviderCurrency("USD", null)).toEqual({
      accepted: true,
      verified: false,
      reason: "provider-silent",
    });
    expect(verifyProviderCurrency("USD", "")).toEqual({
      accepted: true,
      verified: false,
      reason: "provider-silent",
    });
  });

  it("accepts as unverified when the security itself carries no currency", () => {
    expect(verifyProviderCurrency(null, "GBP")).toEqual({
      accepted: true,
      verified: false,
      reason: "security-unset",
    });
  });
});
