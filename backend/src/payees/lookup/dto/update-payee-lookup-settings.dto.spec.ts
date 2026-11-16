import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import {
  TestPayeeLookupKeyDto,
  UpdatePayeeLookupSettingsDto,
} from "./update-payee-lookup-settings.dto";

/**
 * The key never leaves this DTO in a shape the outbound client cannot send.
 *
 * `fetch` refuses a header value holding a control character and quotes the
 * offending value in the `TypeError` it throws, so a stored key with one in it
 * reached the application log and the Test button's error text verbatim -- a
 * secret that is encrypted at rest and never returned to the client precisely
 * so it cannot. `GooglePlacesClient` re-checks the same rule for a key stored
 * before this validator existed; this stops any new one getting in.
 *
 * `plainToInstance` + `validateSync` is the pipeline the app runs
 * (`ValidationPipe` with `transform: true`), so `@Transform` and `@Matches`
 * are exercised in the order a request would.
 */
type KeyDto =
  typeof UpdatePayeeLookupSettingsDto | typeof TestPayeeLookupKeyDto;

/** Written as escapes rather than pasted: a literal one is invisible here. */
const ctrl = (code: number) => String.fromCharCode(code);

describe("payee lookup key validation", () => {
  const errorsFor = (Dto: KeyDto, payload: Record<string, unknown>) =>
    validateSync(plainToInstance(Dto, payload) as object);

  const valueOf = (Dto: KeyDto, payload: Record<string, unknown>) =>
    (plainToInstance(Dto, payload) as { apiKey?: string }).apiKey;

  // Both DTOs carry the key, and only one of them was ever the obvious one to
  // check -- the Test button takes a draft key straight from the client.
  const dtos: [string, KeyDto][] = [
    ["UpdatePayeeLookupSettingsDto", UpdatePayeeLookupSettingsDto],
    ["TestPayeeLookupKeyDto", TestPayeeLookupKeyDto],
  ];

  describe.each(dtos)("%s", (_name, Dto) => {
    it.each([
      ["a newline", `AIza-one${ctrl(0x0a)}AIza-two`],
      ["a carriage return", `AIza-one${ctrl(0x0d)}AIza-two`],
      ["a NUL", `AIza-one${ctrl(0x00)}two`],
      ["a DEL", `AIza-one${ctrl(0x7f)}two`],
      ["a tab", `AIza-one${ctrl(0x09)}two`],
    ])("refuses a key containing %s", (_label, apiKey) => {
      const errors = errorsFor(Dto, { apiKey });
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints?.isSendableApiKey).toBeDefined();
    });

    it("accepts an ordinary key", () => {
      expect(errorsFor(Dto, { apiKey: "AIzaSyA-abc_123-XYZ" })).toEqual([]);
    });

    it("accepts the empty string, which clears the stored key", () => {
      // The one meaningful empty value: absent means "keep what is stored".
      expect(errorsFor(Dto, { apiKey: "" })).toEqual([]);
    });

    it("trims surrounding whitespace rather than storing it", () => {
      // A trailing newline is what a copy-paste leaves. `Headers` strips it
      // anyway, so this is about what gets ENCRYPTED and compared, not about
      // what Google receives.
      expect(valueOf(Dto, { apiKey: `  AIzaSyA-abc  ${ctrl(0x0a)}` })).toBe(
        "AIzaSyA-abc",
      );
    });

    it("reduces an all-whitespace key to the clear-the-key value", () => {
      // Untrimmed it is truthy, so it would be encrypted and stored as a key
      // that is really nothing at all.
      expect(valueOf(Dto, { apiKey: "   " })).toBe("");
    });

    it("leaves an omitted key omitted", () => {
      expect(valueOf(Dto, {})).toBeUndefined();
      expect(errorsFor(Dto, {})).toEqual([]);
    });
  });
});
