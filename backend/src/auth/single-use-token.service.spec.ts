import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { SingleUseTokenService } from "./single-use-token.service";
import { hashToken } from "./crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { runOutsideActiveScopedManager } from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("SingleUseTokenService", () => {
  let service: SingleUseTokenService;
  let manager: Record<string, jest.Mock>;

  beforeEach(async () => {
    const scoped = createScopedDbMocks([]);
    manager = scoped.manager as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SingleUseTokenService,
        { provide: DataSource, useValue: scoped.dataSource },
      ],
    }).compile();

    service = module.get(SingleUseTokenService);
  });

  afterEach(() => jest.clearAllMocks());

  it("wins when the insert returned a row", async () => {
    manager.query.mockResolvedValue([{ token_hash: "abc" }]);

    await expect(service.claim("totp", "user-1:123456", 90_000)).resolves.toBe(
      true,
    );
  });

  it("loses when the primary key already held the claim", async () => {
    manager.query.mockResolvedValue([]);

    await expect(service.claim("totp", "user-1:123456", 90_000)).resolves.toBe(
      false,
    );
  });

  it("lets the primary key decide, never a prior read", async () => {
    manager.query.mockResolvedValue([]);

    await service.claim("ai-action", "action-1", 60_000);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO single_use_tokens");
    expect(sql).toContain("ON CONFLICT (purpose, token_hash) DO NOTHING");
    // Without RETURNING the driver reports nothing for an INSERT, so both
    // outcomes would read as a loss (`common/db/query-result.ts`).
    expect(sql).toContain("RETURNING token_hash");
    expect(sql).not.toMatch(/SELECT[\s\S]*single_use_tokens/i);
  });

  it("stores the hash, never the secret", async () => {
    manager.query.mockResolvedValue([{ token_hash: "x" }]);

    await service.claim("totp", "user-1:123456", 90_000);

    const [, params] = manager.query.mock.calls[0];
    expect(params[1]).toBe(hashToken("user-1:123456"));
    expect(params).not.toContain("user-1:123456");
  });

  it("expires against the database clock", async () => {
    manager.query.mockResolvedValue([{ token_hash: "x" }]);

    await service.claim("totp", "user-1:123456", 90_000);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("CURRENT_TIMESTAMP");
    expect(params[2]).toBe(90_000);
  });

  // A claim guards work, so it must be undone when the work it guards is:
  // joining the caller's transaction is what makes the rollback release it.
  it("joins the caller's transaction", async () => {
    manager.query.mockResolvedValue([{ token_hash: "x" }]);

    await service.claim("ai-action", "action-1", 60_000);

    expect(runOutsideActiveScopedManager).not.toHaveBeenCalled();
  });
});
