import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";

import {
  OauthSigningKeysService,
  keyIds,
} from "@/oauth/oauth-signing-keys.service";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { ENCRYPTION_KEY_ENV } from "@/common/encryption/encryption-key";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The deployment's OIDC signing identity is one identity, whichever process
 * asks for it.
 *
 * Two properties, both of PostgreSQL rather than of the service, so both are
 * exercised against a real one (VER-001, `docs/verification-contract.md`):
 *
 * - **Two replicas racing on first start mint one JWKS.** The singleton primary
 *   key is the arbiter, and the loser has to end up holding the winner's keys
 *   -- not the ones it generated and failed to store, which is the outcome that
 *   would leave two pods signing with two identities while both logged success.
 * - **A restart keeps the `kid`s.** A fresh service over the same row is what a
 *   restarted pod is; the E2E case in this task's scope would restart a
 *   container to say the same thing, and this says it without one.
 *
 * `EncryptionService` is real, with a real key: what is stored is AES-256-GCM
 * ciphertext, and a spec that faked the cipher could not tell a round trip from
 * a JSON copy.
 */
describe("OIDC signing keys (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let encryption: EncryptionService;

  const KEY = "integration-encryption-key-at-least-32-chars";

  const configFor = (key: string | undefined): ConfigService =>
    ({
      get: (name: string, fallback?: string) =>
        name === ENCRYPTION_KEY_ENV
          ? (key ?? fallback ?? "")
          : (fallback ?? ""),
    }) as unknown as ConfigService;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    encryption = new EncryptionService(configFor(KEY));
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM oauth_instance_config");
  });

  const serviceOn = (db: DataSource, enc = encryption) =>
    new OauthSigningKeysService(db, enc);

  it("gives two replicas racing on first start one set of keys", async () => {
    const [first, second] = await Promise.all([
      serviceOn(dataSourceA).ensureJwks(),
      serviceOn(dataSourceB).ensureJwks(),
    ]);

    expect(first).not.toBeNull();
    expect(keyIds(first!)).toEqual(keyIds(second!));

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM oauth_instance_config",
    );
    expect(rows).toHaveLength(1);
  });

  it("serves the same kids to a process that starts later", async () => {
    const minted = await serviceOn(dataSourceA).ensureJwks();

    // A fresh service over the same row: a restarted pod, or the second
    // replica of a deployment that was already running.
    const restarted = await serviceOn(dataSourceB).ensureJwks();

    expect(keyIds(restarted!)).toEqual(keyIds(minted!));
    expect(restarted).toEqual(minted);
  });

  it("round-trips the private halves through real encryption", async () => {
    const minted = await serviceOn(dataSourceA).ensureJwks();

    const [row]: { jwks_enc: string }[] = await dataSourceA.query(
      "SELECT jwks_enc FROM oauth_instance_config",
    );
    // What is on disk is ciphertext; the private halves come back only through
    // the key.
    expect(row.jwks_enc).not.toContain('"kty"');
    expect(JSON.parse(encryption.decrypt(row.jwks_enc))).toEqual(minted);
    expect(minted!.keys.every((key) => typeof key.d === "string")).toBe(true);
  });

  it("stores nothing when the deployment has no encryption key", async () => {
    const unkeyed = serviceOn(
      dataSourceA,
      new EncryptionService(configFor(undefined)),
    );

    await expect(unkeyed.ensureJwks()).resolves.toBeNull();

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM oauth_instance_config",
    );
    expect(rows).toHaveLength(0);
  });

  it("falls back rather than throwing when the key does not match the row", async () => {
    await serviceOn(dataSourceA).ensureJwks();

    const wrongKey = new EncryptionService(
      configFor("a-different-encryption-key-of-32-plus-chars"),
    );

    // The state a production database restored onto another instance leaves
    // behind. Refusing to start the whole OAuth surface over it would be worse
    // than per-process keys the operator can fix by deleting the row.
    // `readJwks` joins the caller's identity, like `PushConfigService.readConfig`;
    // only `ensureJwks` seeds its own, because only it has no request behind it.
    await expect(
      withSystemContext(() => serviceOn(dataSourceB, wrongKey).readJwks()),
    ).resolves.toBeNull();
  });
});
