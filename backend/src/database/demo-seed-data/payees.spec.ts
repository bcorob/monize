import { demoPayees } from "./payees";
import { normalizePhoneNumber } from "../../common/phone-number.util";

/**
 * The demo payees are written straight into the table by raw SQL, so nothing
 * on the way validates them: a website the detail page cannot link, an address
 * longer than the form allows, or a phone in a shape `PayeesService` would
 * have normalized all ship as data the demo shows and the payee form then
 * refuses to save back.
 */
describe("demo payee contact details", () => {
  const withWebsite = demoPayees.filter((p) => p.website);
  const withPhone = demoPayees.filter((p) => p.phone);
  const withAddress = demoPayees.filter((p) => p.address);

  it("carries contact details on the brand payees, so the sweeps below are not vacuous", () => {
    // A refactor that drops the fields would otherwise leave every rule here
    // passing over an empty list.
    expect(withWebsite.length).toBeGreaterThan(25);
    expect(withPhone.length).toBeGreaterThan(25);
    expect(withAddress.length).toBeGreaterThan(25);
  });

  it("stores every phone in the form PayeesService would have normalized it to", () => {
    // Not merely "is valid": equal to its own stored form, which is what makes
    // a demo row and a row the user saves over it compare equal.
    const offenders = withPhone
      .map((payee) => ({
        payee,
        result: normalizePhoneNumber(payee.phone as string, null),
      }))
      .filter(
        ({ payee, result }) => !result.ok || result.stored !== payee.phone,
      )
      .map(({ payee }) => `${payee.name}: ${payee.phone}`);
    expect(offenders).toEqual([]);
  });

  it("gives every website an absolute https address with a host", () => {
    // The column stores absolute URLs so the detail page can put one straight
    // into an anchor, and the favicon resolver takes the host from it.
    const offenders = withWebsite
      .filter((payee) => {
        try {
          const url = new URL(payee.website as string);
          return url.protocol !== "https:" || !url.hostname.includes(".");
        } catch {
          return true;
        }
      })
      .map((payee) => `${payee.name}: ${payee.website}`);
    expect(offenders).toEqual([]);
  });

  it("keeps every value inside the column and DTO bounds", () => {
    const offenders: string[] = [];
    for (const payee of demoPayees) {
      if ((payee.website?.length ?? 0) > 2048)
        offenders.push(`${payee.name}: website`);
      if ((payee.address?.length ?? 0) > 500)
        offenders.push(`${payee.name}: address`);
      if ((payee.phone?.length ?? 0) > 50)
        offenders.push(`${payee.name}: phone`);
    }
    expect(offenders).toEqual([]);
  });

  it("names each payee once", () => {
    // The insert is ON CONFLICT DO NOTHING on (user_id, name), so a duplicate
    // name would silently seed one payee and drop the other's details.
    const names = demoPayees.map((payee) => payee.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
