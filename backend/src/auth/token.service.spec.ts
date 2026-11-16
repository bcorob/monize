import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TokenService } from "./token.service";
import { RefreshToken } from "./entities/refresh-token.entity";
import { hashToken } from "./crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return {
    ...actual,
    randomBytes: jest.fn().mockReturnValue({
      toString: () => "mock-random-token-hex",
    }),
    randomUUID: jest.fn().mockReturnValue("mock-family-uuid"),
  };
});

jest.mock("./crypto.util", () => ({
  hashToken: jest.fn().mockReturnValue("hashed-token"),
}));

describe("TokenService", () => {
  let service: TokenService;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let scopedManager: Record<string, jest.Mock>;

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    authProvider: "local",
    role: "user",
    isActive: true,
  };

  const mockRefreshToken = {
    id: "token-1",
    userId: "user-1",
    tokenHash: "hashed-token",
    familyId: "family-1",
    isRevoked: false,
    rememberMe: false,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    replacedByHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    refreshTokensRepository = {
      create: jest.fn().mockReturnValue(mockRefreshToken),
      save: jest.fn().mockResolvedValue(mockRefreshToken),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-access-token"),
    };

    const scoped = createScopedDbMocks([
      [RefreshToken, refreshTokensRepository as never],
    ]);
    // The advisory family lock and the family-discovery SELECT both go through
    // the manager, so the spec drives them directly.
    scopedManager = scoped.manager;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("30") },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  describe("getRefreshExpiryMs", () => {
    it("should return 1-day expiry when rememberMe is false", () => {
      const result = service.getRefreshExpiryMs(false);

      expect(result).toBe(1 * 24 * 60 * 60 * 1000);
    });

    it("should return 1-day expiry when rememberMe is undefined", () => {
      const result = service.getRefreshExpiryMs();

      expect(result).toBe(1 * 24 * 60 * 60 * 1000);
    });

    it("should return configured REMEMBER_ME_DAYS expiry when rememberMe is true", () => {
      const result = service.getRefreshExpiryMs(true);

      // ConfigService returns "30", so 30 days
      expect(result).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe("generateTokenPair", () => {
    it("should create an access token and refresh token", async () => {
      const result = await service.generateTokenPair(mockUser as any);

      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: "user-1",
          type: "access",
          email: "test@example.com",
          authProvider: "local",
          role: "user",
        },
        { expiresIn: "15m" },
      );
      expect(refreshTokensRepository.create).toHaveBeenCalledWith({
        userId: "user-1",
        tokenHash: "hashed-token",
        familyId: "mock-family-uuid",
        isRevoked: false,
        expiresAt: expect.any(Date),
        replacedByHash: null,
        rememberMe: false,
        actingAsUserId: null,
        delegationId: null,
      });
      expect(refreshTokensRepository.save).toHaveBeenCalledWith(
        mockRefreshToken,
      );
      expect(result).toEqual({
        accessToken: "mock-access-token",
        refreshToken: "mock-random-token-hex",
      });
    });

    it("should use shorter expiry without rememberMe", async () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      await service.generateTokenPair(mockUser as any);

      const createCall = refreshTokensRepository.create.mock.calls[0][0];
      const expectedExpiry = new Date(now + 1 * 24 * 60 * 60 * 1000);
      expect(createCall.expiresAt).toEqual(expectedExpiry);

      jest.restoreAllMocks();
    });

    it("should use longer expiry with rememberMe", async () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      await service.generateTokenPair(mockUser as any, true);

      const createCall = refreshTokensRepository.create.mock.calls[0][0];
      const expectedExpiry = new Date(now + 30 * 24 * 60 * 60 * 1000);
      expect(createCall.expiresAt).toEqual(expectedExpiry);

      jest.restoreAllMocks();
    });

    it("embeds delegate context in the payload and refresh row when acting", async () => {
      await service.generateTokenPair(mockUser as any, false, {
        actingAsUserId: "owner-9",
        delegationId: "deleg-9",
      });

      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: "user-1",
          type: "access",
          email: "test@example.com",
          authProvider: "local",
          role: "user",
          actingAsUserId: "owner-9",
          delegationId: "deleg-9",
        },
        { expiresIn: "15m" },
      );
      const createCall = refreshTokensRepository.create.mock.calls[0][0];
      expect(createCall.actingAsUserId).toBe("owner-9");
      expect(createCall.delegationId).toBe("deleg-9");
    });
  });

  describe("refreshTokens", () => {
    let mockManager: Record<string, jest.Mock>;
    let stageRefresh: (token: unknown, user?: unknown) => void;
    let txEndings: string[];

    beforeEach(() => {
      mockManager = {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
        create: jest.fn().mockImplementation((_Entity, data) => data),
        // The family advisory lock, taken before any row lock so rotation and
        // revocation cannot deadlock (audit P4-011).
        query: jest.fn().mockResolvedValue([]),
      };

      /**
       * Queue the answers `refreshTokens` reads, in the order it reads them.
       *
       * There are two token reads now, not one: an unlocked probe that only
       * learns the family id, then the locked re-read once the family lock is
       * held. Both see the same row.
       */
      stageRefresh = (token: unknown, user?: unknown) => {
        mockManager.findOne
          .mockResolvedValueOnce(token)
          .mockResolvedValueOnce(token);
        if (user !== undefined) {
          mockManager.findOne.mockResolvedValueOnce(user);
        }
      };

      // Record how each transaction ended. A refusal that must revoke has to
      // COMMIT and throw afterwards: a throw inside the callback rolls the
      // revocation back, and a bare "update was called" assertion cannot tell
      // the two apart (A26-H01).
      txEndings = [];
      dataSource.transaction.mockImplementation(async (callback) => {
        try {
          const result = await callback(mockManager);
          txEndings.push("commit");
          return result;
        } catch (error) {
          txEndings.push("rollback");
          throw error;
        }
      });
    });

    /** Answer the grace-successor probe with a live successor. */
    const stageGraceSuccessor = () =>
      mockManager.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes("FROM refresh_tokens") ? [{}] : []),
      );

    it("should rotate token and return new token pair on success", async () => {
      const existingToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      };

      stageRefresh(existingToken, mockUser);

      const result = await service.refreshTokens("raw-refresh-token");

      expect(mockManager.findOne).toHaveBeenCalledWith(RefreshToken, {
        where: { tokenHash: "hashed-token" },
        lock: { mode: "pessimistic_write" },
      });

      expect(existingToken.isRevoked).toBe(true);
      expect(existingToken.replacedByHash).toBe("hashed-token");
      expect(mockManager.save).toHaveBeenCalledWith(existingToken);

      expect(mockManager.create).toHaveBeenCalledWith(RefreshToken, {
        userId: "user-1",
        tokenHash: "hashed-token",
        familyId: "family-1",
        isRevoked: false,
        expiresAt: expect.any(Date),
        replacedByHash: null,
        rememberMe: false,
        actingAsUserId: null,
        delegationId: null,
      });

      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: "user-1",
          type: "access",
          email: "test@example.com",
          authProvider: "local",
          role: "user",
        },
        { expiresIn: "15m" },
      );

      expect(result).toEqual({
        accessToken: "mock-access-token",
        refreshToken: "mock-random-token-hex",
        userId: "user-1",
      });
    });

    it("carries the delegate context forward through rotation", async () => {
      const existingToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        actingAsUserId: "owner-9",
        delegationId: "deleg-9",
      };
      stageRefresh(existingToken, mockUser);

      await service.refreshTokens("raw-refresh-token");

      const createCall = mockManager.create.mock.calls[0][1];
      expect(createCall.actingAsUserId).toBe("owner-9");
      expect(createCall.delegationId).toBe("deleg-9");
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          actingAsUserId: "owner-9",
          delegationId: "deleg-9",
        }),
        { expiresIn: "15m" },
      );
    });

    it("should throw UnauthorizedException when token is not found", async () => {
      mockManager.findOne.mockResolvedValueOnce(null);

      await expect(service.refreshTokens("unknown-token")).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshTokens("unknown-token")).rejects.toThrow(
        "Invalid refresh token",
      );
      // Nothing was written, so this refusal may roll back.
      expect(txEndings).toEqual(["rollback", "rollback"]);
    });

    it("should revoke entire family and throw when token is already revoked (replay detection)", async () => {
      const revokedToken = {
        ...mockRefreshToken,
        isRevoked: true,
        familyId: "family-1",
      };

      stageRefresh(revokedToken);

      await expect(service.refreshTokens("reused-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
      // The revocation committed; the 401 was raised after it.
      expect(txEndings).toEqual(["commit"]);
    });

    it("answers the immediate predecessor inside the grace with an access token only", async () => {
      const predecessor = {
        ...mockRefreshToken,
        isRevoked: true,
        replacedByHash: "successor-hash",
      };
      stageRefresh(predecessor, mockUser);
      stageGraceSuccessor();

      const result = await service.refreshTokens("predecessor-token");

      expect(result).toEqual({
        accessToken: "mock-access-token",
        refreshToken: null,
        userId: "user-1",
      });
      expect(mockManager.query).toHaveBeenCalledWith(
        expect.stringContaining("created_at > CURRENT_TIMESTAMP"),
        ["successor-hash", "family-1", TokenService.ROTATION_GRACE_SECONDS],
      );
      // Nothing revoked, nothing minted.
      expect(mockManager.update).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
      expect(mockManager.create).not.toHaveBeenCalled();
    });

    it("treats a predecessor as reuse when no live successor is inside the grace", async () => {
      const predecessor = {
        ...mockRefreshToken,
        isRevoked: true,
        replacedByHash: "successor-hash",
      };
      stageRefresh(predecessor);

      await expect(service.refreshTokens("predecessor-token")).rejects.toThrow(
        "Refresh token reuse detected",
      );
      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
      expect(txEndings).toEqual(["commit"]);
    });

    it("revokes the family when the user went inactive inside the grace", async () => {
      const predecessor = {
        ...mockRefreshToken,
        isRevoked: true,
        replacedByHash: "successor-hash",
      };
      stageRefresh(predecessor, { ...mockUser, isActive: false });
      stageGraceSuccessor();

      await expect(service.refreshTokens("predecessor-token")).rejects.toThrow(
        "User not found or inactive",
      );
      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
      expect(txEndings).toEqual(["commit"]);
    });

    it("should throw with correct message on replay detection", async () => {
      const revokedToken = {
        ...mockRefreshToken,
        isRevoked: true,
      };

      stageRefresh(revokedToken);

      await expect(service.refreshTokens("reused-token")).rejects.toThrow(
        "Refresh token reuse detected",
      );
    });

    it("should revoke token and throw when token is expired", async () => {
      const expiredToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000),
      };

      stageRefresh(expiredToken);

      await expect(service.refreshTokens("expired-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(expiredToken.isRevoked).toBe(true);
      expect(mockManager.save).toHaveBeenCalledWith(expiredToken);
      expect(txEndings).toEqual(["commit"]);
    });

    it("should throw with correct message on expired token", async () => {
      const expiredToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000),
      };

      stageRefresh(expiredToken);

      await expect(service.refreshTokens("expired-token")).rejects.toThrow(
        "Refresh token expired",
      );
    });

    it("should revoke family and throw when user is not found", async () => {
      const validToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        familyId: "family-1",
      };

      stageRefresh(validToken, null);

      await expect(service.refreshTokens("valid-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
      expect(txEndings).toEqual(["commit"]);
    });

    it("should revoke family and throw when user is inactive", async () => {
      const validToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        familyId: "family-1",
      };

      const inactiveUser = { ...mockUser, isActive: false };

      stageRefresh(validToken, inactiveUser);

      await expect(service.refreshTokens("valid-token")).rejects.toThrow(
        "User not found or inactive",
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
      expect(txEndings).toEqual(["commit"]);
    });
  });

  describe("revokeTokenFamily", () => {
    it("should update all tokens in family to revoked", async () => {
      await service.revokeTokenFamily("family-1");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });
  });

  describe("revokeRefreshToken", () => {
    it("should find token by hash and revoke its family", async () => {
      refreshTokensRepository.findOne.mockResolvedValueOnce({
        ...mockRefreshToken,
        familyId: "family-1",
      });

      await service.revokeRefreshToken("raw-token");

      expect(refreshTokensRepository.findOne).toHaveBeenCalledWith({
        where: { tokenHash: "hashed-token" },
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });

    it("should return early when given an empty string", async () => {
      await service.revokeRefreshToken("");

      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("should return early when given a falsy value", async () => {
      await service.revokeRefreshToken(undefined as any);

      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("should be a no-op when token is not found in DB", async () => {
      refreshTokensRepository.findOne.mockResolvedValueOnce(null);

      await service.revokeRefreshToken("unknown-token");

      expect(refreshTokensRepository.findOne).toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("revokeAllUserRefreshTokens", () => {
    /**
     * Stage the first-round family-discovery SELECT. The family set is captured
     * once, up front (finding 4), so the code reads it a single time and every
     * revoke pass is scoped to that set -- advisory locks and everything else
     * answer with an empty result.
     */
    function stageFirstRound(families: Array<{ family_id: string }>): void {
      scopedManager.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes("DISTINCT family_id")) return families;
        return [];
      });
    }

    it("captures the families once and batch-revokes them, scoped to that set", async () => {
      stageFirstRound([{ family_id: "family-2" }, { family_id: "family-1" }]);
      refreshTokensRepository.update
        .mockResolvedValueOnce({ affected: 2 })
        .mockResolvedValue({ affected: 0 });

      await service.revokeAllUserRefreshTokens("user-1");

      const [where, patch] = refreshTokensRepository.update.mock.calls[0];
      expect(where.userId).toBe("user-1");
      expect(where.isRevoked).toBe(false);
      // Scoped to exactly the captured families via `familyId IN (...)`, never a
      // blanket `user_id AND is_revoked = false` that would sweep a session
      // opened mid-operation (finding 4).
      expect(where.familyId?._type).toBe("in");
      expect(where.familyId?._value).toEqual(["family-1", "family-2"]);
      expect(patch).toEqual({ isRevoked: true });

      // Ascending family order, the same fixed order every other multi-lock path
      // uses, so this cannot deadlock against a rotation holding one family.
      const lockedFamilies = scopedManager.query.mock.calls
        .filter((c) => String(c[0]).includes("pg_advisory_xact_lock"))
        .map((c) => (c[1] as unknown[])[1]);
      expect(lockedFamilies.slice(0, 2)).toEqual(["family-1", "family-2"]);
    });

    it("keeps no session unless asked to", async () => {
      stageFirstRound([{ family_id: "family-1" }]);
      refreshTokensRepository.update.mockResolvedValue({ affected: 0 });

      await service.revokeAllUserRefreshTokens("user-1");

      const select = scopedManager.query.mock.calls.find((c) =>
        String(c[0]).includes("DISTINCT family_id"),
      );
      expect(select![1]).toEqual(["user-1", null]);
    });

    it("leaves the caller's own session out of the captured set when asked to", async () => {
      stageFirstRound([{ family_id: "family-1" }]);
      refreshTokensRepository.update.mockResolvedValue({ affected: 0 });

      await service.revokeAllUserRefreshTokens("user-1", "raw-current-token");

      const select = scopedManager.query.mock.calls.find((c) =>
        String(c[0]).includes("DISTINCT family_id"),
      );
      // The kept family is resolved in SQL from the token's hash, among this
      // user's own rows only; the raw token never reaches the database.
      expect(String(select![0])).toMatch(
        /family_id IS DISTINCT FROM[\s\S]*kept\.user_id = \$1 AND kept\.token_hash = \$2/,
      );
      expect(hashToken).toHaveBeenCalledWith("raw-current-token");
      expect(select![1]).toEqual(["user-1", "hashed-token"]);
      expect(JSON.stringify(select![1])).not.toContain("raw-current-token");
    });

    it("does nothing when the user has no live sessions", async () => {
      stageFirstRound([]);

      await service.revokeAllUserRefreshTokens("user-1");

      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("does not sweep a session opened after the first round (finding 4)", async () => {
      // The regression guard for finding 4. The first round sees only family-1.
      // A concurrent login then opens family-2, which a *later* read would
      // report -- but the earlier code re-discovered families each pass and
      // revoked with a blanket `WHERE user_id AND is_revoked = false`, sweeping
      // that brand-new session. Revocation must stay scoped to the families
      // captured up front, so family-2 is neither re-discovered, locked, nor
      // revoked.
      let selects = 0;
      scopedManager.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes("pg_advisory_xact_lock")) return [];
        if (String(sql).includes("DISTINCT family_id")) {
          selects++;
          return selects === 1
            ? [{ family_id: "family-1" }]
            : [{ family_id: "family-1" }, { family_id: "family-2" }];
        }
        return [];
      });
      refreshTokensRepository.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValue({ affected: 0 });

      await service.revokeAllUserRefreshTokens("user-1");

      // The family set is captured exactly once -- not re-discovered each pass,
      // which is how family-2 would otherwise enter the sweep.
      expect(selects).toBe(1);

      // Every revoke is scoped to the first round's families; family-2 is absent.
      for (const [where] of refreshTokensRepository.update.mock.calls) {
        expect(where.familyId?._type).toBe("in");
        expect(where.familyId?._value).toEqual(["family-1"]);
      }

      // family-2 is never locked either.
      const lockedFamilies = scopedManager.query.mock.calls
        .filter((c) => String(c[0]).includes("pg_advisory_xact_lock"))
        .map((c) => (c[1] as unknown[])[1]);
      expect(lockedFamilies).not.toContain("family-2");
    });

    it("loops until a pass revokes nothing", async () => {
      // The regression guard for the statement-snapshot blind spot behind
      // P4-011: one `UPDATE ... WHERE is_revoked = false` cannot see a
      // replacement a concurrent rotation inserted after its snapshot. Re-locking
      // the captured families and re-revoking until a pass changes nothing
      // converges.
      stageFirstRound([{ family_id: "family-1" }]);
      refreshTokensRepository.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });

      await service.revokeAllUserRefreshTokens("user-1");

      expect(refreshTokensRepository.update.mock.calls.length).toBeGreaterThan(
        1,
      );
      // Captured once, not re-discovered each pass.
      const selects = scopedManager.query.mock.calls.filter((c) =>
        String(c[0]).includes("DISTINCT family_id"),
      );
      expect(selects).toHaveLength(1);
    });

    it("gives up after a bounded number of passes", async () => {
      // A client rotating in a loop must not spin here forever. The cap is a
      // backstop, not an expectation about legitimate clients.
      stageFirstRound([{ family_id: "family-1" }]);
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await service.revokeAllUserRefreshTokens("user-1");

      expect(warn).toHaveBeenCalled();
      expect(refreshTokensRepository.update.mock.calls.length).toBe(10);
    });
  });

  describe("purgeExpiredRefreshTokens", () => {
    // A rotated row stays as the evidence reuse detection needs: replaying a
    // stolen, already-rotated token must find it to revoke the family.
    it("deletes only expired tokens, never by isRevoked", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 3 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledTimes(1);
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        expiresAt: expect.anything(),
      });
      expect(refreshTokensRepository.delete).not.toHaveBeenCalledWith(
        expect.objectContaining({ isRevoked: expect.anything() }),
      );
    });

    it("should log when tokens were purged", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 5 });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).toHaveBeenCalledWith("Purged 5 expired refresh tokens");
    });

    it("should not log when nothing was purged", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 0 });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("should handle undefined affected counts", async () => {
      refreshTokensRepository.delete.mockResolvedValue({
        affected: undefined,
      });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});

describe("TokenService with zero REMEMBER_ME_DAYS", () => {
  it("defaults to 30 days when REMEMBER_ME_DAYS is 0", async () => {
    const module = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: DataSource, useValue: { createQueryRunner: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("0") },
        },
      ],
    }).compile();

    const svc = module.get<TokenService>(TokenService);
    // With REMEMBER_ME_DAYS=0, it falls back to 30 days
    expect(svc.getRefreshExpiryMs(true)).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
