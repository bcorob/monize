import { keyBearingExportTables } from "./export-table-queries";
import { ALWAYS_EXCLUDED_TABLES } from "./support-backup/support-backup-rules";

/**
 * The `api_key_enc` contract, checked across the three places that must agree
 * about which tables carry one.
 *
 * A column named `api_key_enc` is ciphertext under this instance's
 * `ENCRYPTION_KEY`, which never travels in an artifact. So every such table
 * owes three things: the export swaps the ciphertext for the plaintext key,
 * the restore swaps it back, and the support backup drops the table entirely
 * because that artifact is sent to a maintainer.
 *
 * `ai_provider_configs` had all three and a test for each. `payee_lookup_settings`
 * was added to all three by hand and tested by none: deleting it from the
 * restore's list left the entire backup suite green, unit and integration
 * alike. That is the drift these tests exist to stop, so they assert the
 * *derivation* rather than a second copy of the list -- a fourth such table is
 * then correct by construction, and a table that carries the key without
 * declaring itself fails here rather than in somebody's support bundle.
 */
describe("tables carrying an api_key_enc", () => {
  it("is exactly the set the export applies the key transform to", () => {
    // Pinned so this file has to be read when the set changes -- which is the
    // moment the two assertions below start covering something new.
    expect([...keyBearingExportTables()].sort()).toEqual([
      "ai_provider_configs",
      "payee_lookup_settings",
    ]);
  });

  it("never reaches a support backup", () => {
    // The export decrypts the key on its way out and `collectExportTables`
    // applies the same transform the streamed artifact does, so a key-bearing
    // table left in the support bundle ships a third-party credential in
    // plaintext to whoever is debugging a finance bug.
    const leaked = keyBearingExportTables().filter(
      (table) => !ALWAYS_EXCLUDED_TABLES.has(table),
    );
    expect(leaked).toEqual([]);
  });

  it("is asked of the export rather than restated by the restore", () => {
    // The restore re-encrypts by iterating this same derivation. Asserting the
    // derived list is non-empty is what makes the two tests above meaningful:
    // a `keyBearingExportTables` that silently returned nothing would satisfy
    // "nothing leaked" while the restore re-encrypted nothing at all.
    expect(keyBearingExportTables().length).toBeGreaterThan(0);
  });
});
