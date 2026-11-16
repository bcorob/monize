import { DataSource } from "typeorm";

import { SingleUseTokenService } from "@/auth/single-use-token.service";
import { hashToken } from "@/auth/crypto.util";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * "Exactly one winner" is a property of the primary key, so it is tested
 * against the primary key.
 *
 * Two `Set`-based replicas would both answer "not used yet" and both let the
 * code through; the whole claim is that `ON CONFLICT DO NOTHING RETURNING`
 * cannot do that, whichever connection gets there first. A mocked manager can be
 * told to return a row once and proves nothing (VER-001,
 * `docs/verification-contract.md`), so the race below runs on **two separate
 * connections**.
 */
describe("SingleUseTokenService (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let serviceA: SingleUseTokenService;
  let serviceB: SingleUseTokenService;

  const PURPOSE = "totp";
  const TOKEN = "33333333-3333-4333-8333-333333333333:123456";
  const TTL_MS = 90 * 1000;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    serviceA = new SingleUseTokenService(dataSourceA);
    serviceB = new SingleUseTokenService(dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM single_use_tokens");
  });

  it("gives exactly one winner to two connections claiming one code", async () => {
    const results = await withSystemContext(() =>
      Promise.all([
        serviceA.claim(PURPOSE, TOKEN, TTL_MS),
        serviceB.claim(PURPOSE, TOKEN, TTL_MS),
      ]),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM single_use_tokens WHERE purpose = $1",
      [PURPOSE],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a code the other connection spent first", async () => {
    await expect(
      withSystemContext(() => serviceA.claim(PURPOSE, TOKEN, TTL_MS)),
    ).resolves.toBe(true);
    await expect(
      withSystemContext(() => serviceB.claim(PURPOSE, TOKEN, TTL_MS)),
    ).resolves.toBe(false);
  });

  it("stores only the hash", async () => {
    await withSystemContext(() => serviceA.claim(PURPOSE, TOKEN, TTL_MS));

    const rows: { token_hash: string }[] = await dataSourceA.query(
      "SELECT token_hash FROM single_use_tokens WHERE purpose = $1",
      [PURPOSE],
    );
    expect(rows[0].token_hash).toBe(hashToken(TOKEN));
    expect(rows[0].token_hash).not.toContain("123456");
  });

  it("keeps two purposes apart on one token", async () => {
    await expect(
      withSystemContext(() => serviceA.claim("totp", TOKEN, TTL_MS)),
    ).resolves.toBe(true);
    // The composite key is what lets an AI action and a TOTP code share a
    // string without one consuming the other.
    await expect(
      withSystemContext(() => serviceB.claim("ai-action", TOKEN, TTL_MS)),
    ).resolves.toBe(true);
  });

  it("treats an expired row as spent, not as free", async () => {
    await withSystemContext(() => serviceA.claim(PURPOSE, TOKEN, TTL_MS));
    await dataSourceA.query(
      `UPDATE single_use_tokens
          SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE purpose = $1`,
      [PURPOSE],
    );

    // The sweep deletes these; until it runs the key still holds. Nothing here
    // depends on the difference -- what these rows guard is dead by then -- and
    // the safe direction is to refuse.
    await expect(
      withSystemContext(() => serviceB.claim(PURPOSE, TOKEN, TTL_MS)),
    ).resolves.toBe(false);
  });
});
