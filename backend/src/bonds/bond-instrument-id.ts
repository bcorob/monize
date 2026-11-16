import { createHash } from "node:crypto";

/**
 * The namespace of every bond instrument id. Fixed for ever: changing it would
 * give every instrument a new id and orphan each security's link.
 */
export const BOND_INSTRUMENT_NAMESPACE = "b2c1f3a4-6d5e-4f70-9a8b-1c2d3e4f5a6b";

/** RFC 4122 UUID version 5 (SHA-1) of `name` in `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (namespaceBytes.length !== 16) {
    throw new TypeError(`Not a UUID: ${namespace}`);
  }
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The id of a catalog instrument, derived from the unique key
 * `(issuer_country_code, issuer_code, series_code)`.
 *
 * `bond_instruments` is excluded from the user backup and seeded per
 * deployment, so a random id would differ between deployments and a security's
 * link would not survive a restore onto another one. The same series has the
 * same id everywhere.
 */
export function bondInstrumentId(
  issuerCountryCode: string,
  issuerCode: string,
  seriesCode: string,
): string {
  return uuidV5(
    `${issuerCountryCode}|${issuerCode}|${seriesCode}`,
    BOND_INSTRUMENT_NAMESPACE,
  );
}

/**
 * The namespace of every bond program id. Fixed for ever, like the instrument
 * namespace: changing it would orphan each security's link.
 */
export const BOND_PROGRAM_NAMESPACE = "7e4d9a10-3c2b-4b6f-8d15-a0c9e2f6b384";

/**
 * The id of a catalog program (the product, e.g. EDO), derived from the unique
 * key `(issuer_country_code, issuer_code, program_code)` for the reason
 * `bondInstrumentId` is: `bond_programs` is seeded per deployment and a
 * security's link must survive a restore onto another one.
 */
export function bondProgramId(
  issuerCountryCode: string,
  issuerCode: string,
  programCode: string,
): string {
  return uuidV5(
    `${issuerCountryCode}|${issuerCode}|${programCode}`,
    BOND_PROGRAM_NAMESPACE,
  );
}
