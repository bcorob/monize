import { describe, expect, it } from 'vitest';
import { buildPayeeSchema } from './PayeeForm';
import type { CountryCode } from 'libphonenumber-js/max';

/**
 * The form's validation rules, tested against the schema itself.
 *
 * `PayeeForm.test.tsx` mocks `zodResolver` into a pass-through so its submit
 * handlers receive real field values, which means no rule declared in the
 * schema is exercised from there -- a malformed email submits cleanly in that
 * suite no matter what the schema says. These assertions are the ones with
 * teeth.
 */
const t = (key: string) => key;
/** The region a bare national number is read in; US unless a case says otherwise. */
const parse = (
  input: Record<string, unknown>,
  phoneRegion: CountryCode | null | undefined = 'US',
) => buildPayeeSchema(t, phoneRegion).safeParse({ name: 'Starbucks', ...input });

describe('payee form schema', () => {
  it('accepts a well-formed email', () => {
    expect(parse({ email: 'hello@starbucks.com' }).success).toBe(true);
  });

  it('rejects a malformed email with the localized message', () => {
    const result = parse({ email: 'not an email' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['email'],
      message: 'validation.emailInvalid',
    });
  });

  it('accepts a blank email, because that is how the field is cleared', () => {
    // The form resends every field, so an emptied email arrives as "". A
    // schema that rejected it would block every save from a payee with no
    // email at all.
    expect(parse({ email: '' }).success).toBe(true);
  });

  it('accepts an omitted email', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts a multi-line address', () => {
    expect(parse({ address: '1912 Pike Pl\nSeattle, WA 98101' }).success).toBe(
      true,
    );
  });

  it('rejects an address longer than the column holds', () => {
    expect(parse({ address: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects a phone number longer than the column holds', () => {
    expect(parse({ phone: '5'.repeat(51) }).success).toBe(false);
  });

  it('accepts a phone number in any shape the user writes it', () => {
    // Brackets, spaces, dots, an extension and a country code are all ways of
    // writing one number; the shape is the user's business, the number is not.
    for (const phone of [
      '+1 (206) 448-8762',
      '206.448.8762',
      '206 448 8762',
      '+44 20 7946 0958 ext. 12',
      '+442079460958;ext=12',
    ]) {
      expect(parse({ phone }).success).toBe(true);
    }
  });

  it('accepts a bare national number in the region the preferences imply', () => {
    expect(parse({ phone: '020 7946 0958' }, 'GB').success).toBe(true);
    // ...and the same digits are not a US number.
    expect(parse({ phone: '020 7946 0958' }, 'US').success).toBe(false);
  });

  it('rejects a number that is not one, under the field', () => {
    const result = parse({ phone: '12345' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['phone'],
      message: 'validation.phoneInvalid',
    });
  });

  it('asks for a country code when it cannot place the number', () => {
    // A different message because it is a different repair: checking the digits
    // would not help a user whose number is correct and merely unplaceable.
    const result = parse({ phone: '020 7946 0958' }, null);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['phone'],
      message: 'validation.phoneNeedsCountryCode',
    });
  });

  it('accepts a blank phone, because that is how the field is cleared', () => {
    expect(parse({ phone: '' }).success).toBe(true);
  });

  it('still requires a name', () => {
    expect(buildPayeeSchema(t, 'US').safeParse({ name: '' }).success).toBe(false);
  });

  it('accepts a legacy number the payee already holds, so the row stays editable', () => {
    // Rows written before normalization are not backfilled, and the server
    // waives a value that did not move. Were this field stricter, a payee
    // holding free text could not be edited at all from here -- the browser
    // refusing a change the API would take.
    const result = buildPayeeSchema(t, 'US', 'call the shop').safeParse({
      name: 'Corner Shop',
      phone: 'call the shop',
    });

    expect(result.success).toBe(true);
  });

  it('still refuses a bad value that replaces the legacy one', () => {
    const result = buildPayeeSchema(t, 'US', 'call the shop').safeParse({
      name: 'Corner Shop',
      phone: '12345',
    });

    expect(result.success).toBe(false);
  });

  it('checks nothing while the region is still unknown', () => {
    // `undefined` is not `null`: null is an ANSWER (the preferences name no
    // region, so a bare number is unplaceable), undefined is "the preferences
    // have not loaded". Defaulting the second to US would have this form reject
    // a Berlin number the API stores -- the browser refusing what the API takes,
    // which is the one thing the shared truth table cannot catch, because it
    // tests the functions and not the inputs they are handed.
    // Called directly: `parse(input, undefined)` would take the helper's own
    // default and never reach the schema with an unknown region.
    const unknown = (phone: string) =>
      buildPayeeSchema(t, undefined).safeParse({ name: 'Starbucks', phone });
    expect(unknown('030 12345678').success).toBe(true);
    expect(unknown('nonsense').success).toBe(true);
    // ...and once they load, the rule applies again, both ways.
    expect(parse({ phone: '030 12345678' }, 'DE').success).toBe(true);
    expect(parse({ phone: '030 12345678' }, 'US').success).toBe(false);
  });

  it('waives nothing when the payee has no stored phone', () => {
    // A new payee has no value to resend, so every number is checked.
    expect(buildPayeeSchema(t, 'US').safeParse({ name: 'A', phone: '12345' }).success).toBe(
      false,
    );
  });
});
