import { DataSource } from "typeorm";

import { SingleUseTokenService } from "@/auth/single-use-token.service";
import { AI_ACTION_CLAIM_PURPOSE } from "@/ai/actions/ai-actions.service";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * A confirmed AI action descriptor is spent once per deployment.
 *
 * The descriptor is signed and handed to the client, which posts it back to
 * `/ai/actions/confirm` -- so the replay guard is the only thing between one
 * approval and two writes, and it used to be a `Map` each replica kept to
 * itself. What replaces it is the `single_use_tokens` primary key, and that is
 * a PostgreSQL property: two connections confirm one `actionId` here, and
 * exactly one may proceed (VER-001, `docs/verification-contract.md`).
 *
 * `AiActionsService` itself is not built here. Its constructor pulls half the
 * write surface, and none of it participates in the property -- what decides
 * the winner is the claim, so the claim is what is raced, with the service's
 * own purpose constant so a rename cannot silently make this spec test a string
 * nothing uses.
 */
describe("AI action anti-replay (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let serviceA: SingleUseTokenService;
  let serviceB: SingleUseTokenService;

  const ACTION_ID = "44444444-4444-4444-8444-444444444444";
  const TTL_MS = 10 * 60 * 1000;

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

  it("lets exactly one of two concurrent confirmations proceed", async () => {
    const results = await withSystemContext(() =>
      Promise.all([
        serviceA.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
        serviceB.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
      ]),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses the replica that did not win, on a later attempt too", async () => {
    await withSystemContext(() =>
      serviceA.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
    );

    await expect(
      withSystemContext(() =>
        serviceB.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
      ),
    ).resolves.toBe(false);
  });

  // `execute` fans out across several transactions of its own, so a failed
  // apply has no rollback to give the claim back -- `release` does, and the
  // descriptor stays confirmable on any replica.
  it("makes the descriptor confirmable again after a released claim", async () => {
    await withSystemContext(() =>
      serviceA.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
    );
    await withSystemContext(() =>
      serviceA.release(AI_ACTION_CLAIM_PURPOSE, ACTION_ID),
    );

    await expect(
      withSystemContext(() =>
        serviceB.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
      ),
    ).resolves.toBe(true);
  });

  it("keeps an AI action's claim clear of a TOTP code's", async () => {
    await withSystemContext(() =>
      serviceA.claim(AI_ACTION_CLAIM_PURPOSE, ACTION_ID, TTL_MS),
    );

    await expect(
      withSystemContext(() => serviceB.claim("totp", ACTION_ID, TTL_MS)),
    ).resolves.toBe(true);
  });
});
