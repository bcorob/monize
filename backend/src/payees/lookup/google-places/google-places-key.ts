import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/**
 * What a Google Places API key must look like to be *sendable*, written once.
 *
 * The key travels as the `X-Goog-Api-Key` request header, and `fetch` refuses
 * a header value holding a control character -- **quoting the offending value
 * in the `TypeError` it throws**. That error reached the application log
 * through `ProviderHealthService.logFailure`, and the Test button's error text
 * through `describeTestFailure`, so a key with one in it was printed verbatim
 * in both. The key is encrypted at rest with AES-256-GCM and never returned to
 * the client precisely so that cannot happen.
 *
 * Two callers, one rule, because they guard different doors and neither covers
 * the other: `UpdatePayeeLookupSettingsDto` stops a new key being stored, and
 * `GooglePlacesClient` refuses to send a key stored before that validator
 * existed -- or the operator's own `GOOGLE_PLACES_API_KEY`, which no DTO ever
 * sees. Spelled twice they could disagree; here they cannot.
 *
 * Control characters and DEL are the whole set, because they are exactly what
 * the platform rejects: a space, and any non-ASCII character, are values
 * `Headers` accepts, and nothing else about a key's shape is the caller's
 * business -- only Google can say whether a key is real. Surrounding
 * whitespace is not rejected either: `Headers` strips it before validating, so
 * the trailing newline a copy-paste leaves is harmless, and the DTO trims it
 * anyway so it is never what gets encrypted.
 *
 * Written as code-point arithmetic rather than as a regular expression on
 * purpose: a character class of control characters is a class of bytes nobody
 * can read in a diff, and `no-control-regex` exists because such a class is
 * usually a typo. Here it would be the subject, and the reader still could not
 * see it.
 */

/** Highest code point that cannot appear in a header value (C0 controls). */
const LAST_CONTROL = 0x1f;
/** DEL, the one control character above the printable range. */
const DELETE = 0x7f;

/** Whether this key can be put in a request header at all. */
export function isSendableApiKey(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= LAST_CONTROL || code === DELETE) return false;
  }
  // The empty string reaches here and passes, which is deliberate: `apiKey: ""`
  // is how the settings card clears a stored key, and rejecting it would make
  // a key impossible to remove.
  return true;
}

/**
 * DTO decorator form of the same rule.
 *
 * A decorator rather than `@Matches(...)` so both doors call one function --
 * and so the check the client makes at send time and the check the API makes
 * at store time cannot drift into disagreeing about one character.
 */
export function IsSendableApiKey(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      name: "isSendableApiKey",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" && isSendableApiKey(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must not contain control characters`,
      },
    });
  };
}
