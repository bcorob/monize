import { isNumberLocale } from "./is-number-locale.validator";

describe("isNumberLocale", () => {
  it("accepts the browser sentinel", () => {
    // "browser" is not a locale, it is the instruction to follow one.
    expect(isNumberLocale("browser")).toBe(true);
  });

  it("accepts BCP 47 tags the app offers", () => {
    for (const tag of ["en", "en-US", "en-GB", "pl-PL", "pt-BR", "zh-CN"]) {
      expect(isNumberLocale(tag)).toBe(true);
    }
  });

  it("rejects the underscore form Intl cannot parse", () => {
    // The value that got through `@IsString() @MaxLength(50)` and then threw
    // RangeError inside every formatter built from it.
    expect(isNumberLocale("en_US")).toBe(false);
    expect(isNumberLocale("pl_PL")).toBe(false);
  });

  it("rejects an empty string and a non-string", () => {
    expect(isNumberLocale("")).toBe(false);
    expect(isNumberLocale(null)).toBe(false);
    expect(isNumberLocale(undefined)).toBe(false);
    expect(isNumberLocale(42)).toBe(false);
  });

  it("accepts a well-formed tag no platform data backs", () => {
    // Structurally valid, so Intl resolves it to its own default rather than
    // throwing. Refusing it here would reject a locale a future ICU may know.
    expect(isNumberLocale("zzz")).toBe(true);
  });
});
