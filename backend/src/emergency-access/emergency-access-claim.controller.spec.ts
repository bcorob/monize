import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EmergencyAccessClaimController } from "./emergency-access-claim.controller";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { User } from "../users/entities/user.entity";
import { TokenService } from "../auth/token.service";
import { AuthService } from "../auth/auth.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { hashToken } from "../auth/crypto.util";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("EmergencyAccessClaimController", () => {
  let controller: EmergencyAccessClaimController;
  let contactsRepo: Record<string, jest.Mock>;
  let settingsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let tokenService: Record<string, jest.Mock>;
  let authService: Record<string, jest.Mock>;
  let passwordBreach: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: Record<string, jest.Mock>;
  };
  let dataSource: Record<string, jest.Mock>;

  const ownerId = "11111111-1111-1111-1111-111111111111";
  const RAW_TOKEN = "a".repeat(64);
  /** Whether the conditional consume returns a row this run. */
  let claimWins: boolean;
  const TOKEN_HASH = hashToken(RAW_TOKEN);

  beforeEach(async () => {
    contactsRepo = {
      // complete() now pre-validates the link via contactsRepo.findOne before
      // any expensive work; default to a valid contact so the existing
      // transaction-path tests reach the in-transaction re-validation.
      findOne: jest.fn().mockResolvedValue({
        id: "c1",
        ownerUserId: ownerId,
        claimTokenHash: TOKEN_HASH,
        claimTokenExpiresAt: new Date(Date.now() + 100000),
        claimTokenUsedAt: null,
      }),
    };
    settingsRepo = { findOne: jest.fn() };
    usersRepo = { findOne: jest.fn() };
    tokenService = {
      revokeAllUserRefreshTokens: jest.fn(),
      generateTokenPair: jest
        .fn()
        .mockResolvedValue({ accessToken: "a", refreshToken: "r" }),
      getRefreshExpiryMs: jest.fn().mockReturnValue(1000),
    };
    authService = { getCsrfKey: jest.fn().mockReturnValue("k".repeat(32)) };
    passwordBreach = { isBreached: jest.fn().mockResolvedValue(false) };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      decrypt: jest.fn((s) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
    };
    configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };

    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        save: jest.fn(async (row) => row),
        delete: jest.fn(),
        createQueryBuilder: jest.fn(() => updateBuilder),
      },
    };
    // Every read/write now runs through `withScopedDb`; the former QueryRunner
    // is the transaction's EntityManager, so keep `queryRunner.manager` pointing
    // at the same jest.fn()s the manager exposes.
    const scoped = createScopedDbMocks([
      [EmergencyAccessContact, contactsRepo as never],
      [EmergencyAccessSettings, settingsRepo as never],
      [User, usersRepo as never],
    ]);
    Object.assign(scoped.manager, queryRunner.manager);
    queryRunner.manager = scoped.manager;

    /**
     * The claim token is consumed by ONE conditional statement, before any
     * credential is touched: `claim_token_used_at IS NULL` and the expiry are
     * predicates of the UPDATE, so PostgreSQL re-evaluates them after the row
     * lock and exactly one caller gets a row back (audit P4-007). The double
     * answers the way that statement does.
     */
    claimWins = true;
    scoped.manager.query.mockImplementation(async (sql: string) => {
      if (!String(sql).includes("UPDATE emergency_access_contacts")) return [];
      return claimWins ? [[{ id: "c1", owner_user_id: ownerId }], 1] : [[], 0];
    });
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmergencyAccessClaimController],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: TokenService, useValue: tokenService },
        { provide: AuthService, useValue: authService },
        { provide: PasswordBreachService, useValue: passwordBreach },
        { provide: EncryptionService, useValue: encryption },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    controller = module.get(EmergencyAccessClaimController);
  });

  describe("preview", () => {
    it("returns owner info + decrypted message for a valid token", async () => {
      contactsRepo.findOne.mockResolvedValue({
        id: "c1",
        ownerUserId: ownerId,
        firstName: "Carol",
        claimTokenHash: TOKEN_HASH,
        claimTokenExpiresAt: new Date(Date.now() + 100000),
        claimTokenUsedAt: null,
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: ownerId,
        messageCiphertext: "enc(secret)",
      });
      usersRepo.findOne.mockResolvedValue({
        id: ownerId,
        firstName: "Owner",
        lastName: "One",
      });

      const res = await controller.preview({ token: RAW_TOKEN });
      expect(res.ownerFirstName).toBe("Owner");
      expect(res.contactFirstName).toBe("Carol");
      expect(res.message).toBe("secret");
    });

    // RLS (task C4): the claimant is the grantee, not the owner, so the
    // owner-keyed reads run under a system context.
    it("runs the owner-keyed reads under a system context", async () => {
      let ctx: ReturnType<typeof getRequestContext>;
      contactsRepo.findOne.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({
          id: "c1",
          ownerUserId: ownerId,
          firstName: "Carol",
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        });
      });
      settingsRepo.findOne.mockResolvedValue({ ownerUserId: ownerId });
      usersRepo.findOne.mockResolvedValue({ id: ownerId, firstName: "Owner" });

      await controller.preview({ token: RAW_TOKEN });

      expect(ctx).toEqual({ system: true });
    });

    it("rejects an unknown / used / expired token", async () => {
      contactsRepo.findOne.mockResolvedValue(null);
      await expect(
        controller.preview({ token: RAW_TOKEN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an expired token", async () => {
      contactsRepo.findOne.mockResolvedValue({
        claimTokenHash: TOKEN_HASH,
        claimTokenExpiresAt: new Date(Date.now() - 1000),
        claimTokenUsedAt: null,
      });
      await expect(
        controller.preview({ token: RAW_TOKEN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("complete", () => {
    function makeRes(): {
      cookie: jest.Mock;
      json: jest.Mock;
    } {
      return { cookie: jest.fn(), json: jest.fn() };
    }

    it("consumes the token before touching a single credential", async () => {
      // The regression guard for P4-007. The old shape was a findOne followed by
      // an entity save, under a comment claiming it revalidated "under lock" --
      // there was no lock and no predicate, so two requests could both read the
      // unused token, both replace the owner's password with a different value,
      // and both mark it used. An account-takeover race, not merely a duplicate.
      // The owner is loaded through the transaction manager as well as the repo.
      queryRunner.manager.findOne.mockResolvedValue({
        id: ownerId,
        email: "o@x.com",
      });
      usersRepo.findOne.mockResolvedValue({ id: ownerId, email: "o@x.com" });
      settingsRepo.findOne.mockResolvedValue({ ownerUserId: ownerId });
      const res = makeRes();

      await controller.complete(
        { token: RAW_TOKEN, newPassword: "Password12345!" },
        res as never,
      );

      const [sql, params] = queryRunner.manager.query.mock.calls[0];
      expect(sql).toContain("UPDATE emergency_access_contacts");
      expect(sql).toContain("claim_token_used_at IS NULL");
      expect(sql).toContain("claim_token_expires_at >= CURRENT_TIMESTAMP");
      expect(sql).toContain("RETURNING");
      expect(params).toEqual([TOKEN_HASH]);
      // And it is the FIRST statement: nothing may be written by a caller that
      // is about to lose the claim.
      const credentialWrite =
        queryRunner.manager.createQueryBuilder.mock.invocationCallOrder[0];
      expect(
        queryRunner.manager.query.mock.invocationCallOrder[0],
      ).toBeLessThan(credentialWrite);
    });

    it("refuses the second consumer and writes nothing", async () => {
      claimWins = false;
      usersRepo.findOne.mockResolvedValue({ id: ownerId, email: "o@x.com" });
      const res = makeRes();

      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Password12345!" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(queryRunner.manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it("rejects breached passwords", async () => {
      passwordBreach.isBreached.mockResolvedValue(true);
      const res = makeRes();
      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Password12345!" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an invalid token before running the breach check", async () => {
      // Unauthenticated callers must not be able to trigger the HIBP lookup
      // or a bcrypt hash with a bogus token.
      contactsRepo.findOne.mockResolvedValue(null);
      const res = makeRes();
      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(passwordBreach.isBreached).not.toHaveBeenCalled();
      // The token pre-check is its own short read; the claim write block must
      // never be entered.
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("replaces credentials, voids sibling tokens, and signs in", async () => {
      queryRunner.manager.findOne
        .mockResolvedValueOnce({
          id: "c1",
          ownerUserId: ownerId,
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        })
        .mockResolvedValueOnce({ id: ownerId });
      usersRepo.findOne.mockResolvedValue({ id: ownerId, isActive: true });

      const res = makeRes();
      await controller.complete(
        { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
        res as never,
      );

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(tokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        ownerId,
      );
      expect(tokenService.generateTokenPair).toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "a",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it("rolls back when the token is no longer valid in-transaction", async () => {
      queryRunner.manager.findOne.mockResolvedValueOnce(null);
      const res = makeRes();
      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });

    it("rolls back when the owner row is missing in-transaction", async () => {
      queryRunner.manager.findOne
        .mockResolvedValueOnce({
          id: "c1",
          ownerUserId: ownerId,
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        })
        .mockResolvedValueOnce(null);

      const res = makeRes();
      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });

    it("throws when the freshly-refetched owner is missing after the commit", async () => {
      queryRunner.manager.findOne
        .mockResolvedValueOnce({
          id: "c1",
          ownerUserId: ownerId,
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        })
        .mockResolvedValueOnce({ id: ownerId });
      usersRepo.findOne.mockResolvedValue(null);

      const res = makeRes();
      await expect(
        controller.complete(
          { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });

    it("voids sibling tokens via a TypeORM function-valued setter", async () => {
      queryRunner.manager.findOne
        .mockResolvedValueOnce({
          id: "c1",
          ownerUserId: ownerId,
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        })
        .mockResolvedValueOnce({ id: ownerId });
      usersRepo.findOne.mockResolvedValue({ id: ownerId, isActive: true });

      // Capture the most recent `set()` call argument.
      const setCalls: Array<Record<string, unknown>> = [];
      const builder = queryRunner.manager.createQueryBuilder() as unknown as {
        set: jest.Mock;
      };
      builder.set.mockImplementation((arg: Record<string, unknown>) => {
        setCalls.push(arg);
        return builder;
      });

      const res = makeRes();
      await controller.complete(
        { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
        res as never,
      );

      // Find the sibling-void update (the one with `claim_voided_reason`).
      const voidUpdate = setCalls.find(
        (s) => s.claimVoidedReason === "claimed_by_other",
      );
      expect(voidUpdate).toBeDefined();
      expect(typeof voidUpdate!.claimTokenUsedAt).toBe("function");
      expect((voidUpdate!.claimTokenUsedAt as () => string)()).toBe(
        "CURRENT_TIMESTAMP",
      );
    });
  });

  describe("preview missing data", () => {
    function validContact() {
      return {
        id: "c1",
        ownerUserId: ownerId,
        firstName: "Carol",
        claimTokenHash: TOKEN_HASH,
        claimTokenExpiresAt: new Date(Date.now() + 100000),
        claimTokenUsedAt: null,
      };
    }

    it("throws when the settings row is missing", async () => {
      contactsRepo.findOne.mockResolvedValue(validContact());
      settingsRepo.findOne.mockResolvedValue(null);
      usersRepo.findOne.mockResolvedValue({
        id: ownerId,
        firstName: "Owner",
      });
      await expect(
        controller.preview({ token: RAW_TOKEN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws when the owner row is missing", async () => {
      contactsRepo.findOne.mockResolvedValue(validContact());
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: ownerId,
        messageCiphertext: null,
      });
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        controller.preview({ token: RAW_TOKEN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns a null message when decryption throws", async () => {
      contactsRepo.findOne.mockResolvedValue(validContact());
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: ownerId,
        messageCiphertext: "enc(garbage)",
      });
      usersRepo.findOne.mockResolvedValue({
        id: ownerId,
        firstName: "Owner",
        lastName: "One",
      });
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });

      const res = await controller.preview({ token: RAW_TOKEN });
      expect(res.message).toBeNull();
    });

    it("returns a null message when the encryption key is not configured", async () => {
      contactsRepo.findOne.mockResolvedValue(validContact());
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: ownerId,
        messageCiphertext: "enc(unreadable)",
      });
      usersRepo.findOne.mockResolvedValue({
        id: ownerId,
        firstName: "Owner",
        lastName: "One",
      });
      encryption.isConfigured.mockReturnValue(false);

      const res = await controller.preview({ token: RAW_TOKEN });
      expect(res.message).toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("returns a null message when decrypt throws a non-Error value", async () => {
      contactsRepo.findOne.mockResolvedValue(validContact());
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: ownerId,
        messageCiphertext: "enc(corrupt)",
      });
      usersRepo.findOne.mockResolvedValue({
        id: ownerId,
        firstName: "Owner",
        lastName: "One",
      });
      encryption.decrypt.mockImplementation(() => {
        throw "raw-string-not-an-Error";
      });

      const res = await controller.preview({ token: RAW_TOKEN });
      expect(res.message).toBeNull();
    });
  });

  describe("secure cookie attribute", () => {
    it("sets secure: true on cookies in production", async () => {
      configService.get.mockImplementation((key: string, fallback?: string) => {
        if (key === "NODE_ENV") return "production";
        if (key === "DISABLE_HTTPS_HEADERS") return "false";
        return fallback;
      });
      const prodModule = await Test.createTestingModule({
        controllers: [EmergencyAccessClaimController],
        providers: [
          { provide: DataSource, useValue: dataSource },
          { provide: TokenService, useValue: tokenService },
          { provide: AuthService, useValue: authService },
          { provide: PasswordBreachService, useValue: passwordBreach },
          { provide: EncryptionService, useValue: encryption },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();
      const prodController = prodModule.get(EmergencyAccessClaimController);

      queryRunner.manager.findOne
        .mockResolvedValueOnce({
          id: "c1",
          ownerUserId: ownerId,
          claimTokenHash: TOKEN_HASH,
          claimTokenExpiresAt: new Date(Date.now() + 100000),
          claimTokenUsedAt: null,
        })
        .mockResolvedValueOnce({ id: ownerId });
      usersRepo.findOne.mockResolvedValue({ id: ownerId, isActive: true });

      const cookies: Array<[string, string, Record<string, unknown>]> = [];
      const res = {
        cookie: jest.fn(
          (name: string, value: string, opts: Record<string, unknown>) => {
            cookies.push([name, value, opts]);
          },
        ),
        json: jest.fn(),
      };
      await prodController.complete(
        { token: RAW_TOKEN, newPassword: "Aa1!correcthorse" },
        res as never,
      );

      const auth = cookies.find(([n]) => n === "auth_token");
      expect(auth?.[2]?.secure).toBe(true);
    });
  });
});
