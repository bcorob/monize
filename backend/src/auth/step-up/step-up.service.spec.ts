import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";

import { StepUpAuthService } from "./step-up.service";
import { TwoFactorService } from "../two-factor.service";
import { User } from "../../users/entities/user.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  withStepUpClaimLedger,
} from "../../test-helpers/scoped-db-testing";
import { OidcReauthService } from "../oidc/oidc-reauth.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

describe("StepUpAuthService", () => {
  // The artifacts below are real, so the spec needs the signing key. `jwt.sign`
  // is mocked at the module level for the step-up token itself; OidcReauthService
  // uses `jsonwebtoken` directly, which is not.
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "spec-jwt-secret-of-at-least-32-characters";
  });

  afterAll(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  let service: StepUpAuthService;
  let usersRepo: Record<string, jest.Mock>;
  let preferencesRepo: Record<string, jest.Mock>;
  let twoFactor: Record<string, jest.Mock>;
  let jwt: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    usersRepo = { findOne: jest.fn() };
    preferencesRepo = { findOne: jest.fn() };
    twoFactor = { verifyTotpForUser: jest.fn() };
    jwt = { sign: jest.fn().mockReturnValue("signed.jwt.token") };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Real instance: the class exists to verify signatures, and a mock
        // that always accepts would make the re-authentication assertions
        // vacuous -- which is how the sentinel survived (P2-005).
        OidcReauthService,
        {
          provide: DataSource,
          useValue: (() => {
            const scoped = createScopedDbMocks([
              [User, usersRepo as never],
              [UserPreference, preferencesRepo as never],
            ]);
            // The real OidcReauthService spends each artifact's jti in the
            // oidc_step_up_claims ledger; answer like the table does.
            withStepUpClaimLedger(scoped.manager.query);
            return scoped.dataSource;
          })(),
        },
        StepUpAuthService,
        { provide: TwoFactorService, useValue: twoFactor },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(StepUpAuthService);
  });

  it("throws NotFoundException when the user is missing", async () => {
    usersRepo.findOne.mockResolvedValue(null);
    await expect(
      service.verifyAndIssue(userId, "emergency-access", {
        password: "x",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("2FA-enabled users", () => {
    beforeEach(() => {
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        authProvider: "local",
        passwordHash: "irrelevant",
        twoFactorSecret: "enc-secret",
      });
      preferencesRepo.findOne.mockResolvedValue({ twoFactorEnabled: true });
    });

    it("requires totpCode and rejects password-only attempts", async () => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          password: "hunter2",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(twoFactor.verifyTotpForUser).not.toHaveBeenCalled();
    });

    it("issues a token when the TOTP code is valid", async () => {
      twoFactor.verifyTotpForUser.mockResolvedValue(true);
      const result = await service.verifyAndIssue(userId, "emergency-access", {
        totpCode: "123456",
      });

      expect(twoFactor.verifyTotpForUser).toHaveBeenCalledWith(
        userId,
        "123456",
      );
      expect(jwt.sign).toHaveBeenCalled();
      const payload = jwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({
        sub: userId,
        type: "step_up",
        purpose: "emergency-access",
      });
      expect(typeof payload.jti).toBe("string");
      expect(result.stepUpToken).toBe("signed.jwt.token");
      expect(result.expiresInSeconds).toBe(300);
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("rejects invalid TOTP codes", async () => {
      twoFactor.verifyTotpForUser.mockResolvedValue(false);
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          totpCode: "999999",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("local users without 2FA", () => {
    beforeEach(async () => {
      const hash = await bcrypt.hash("hunter2", 4);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        authProvider: "local",
        passwordHash: hash,
        twoFactorSecret: null,
      });
      preferencesRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
    });

    it("requires password and rejects totp-only attempts", async () => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          totpCode: "123456",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("issues a token when the password is correct", async () => {
      const result = await service.verifyAndIssue(userId, "emergency-access", {
        password: "hunter2",
      });
      expect(result.stepUpToken).toBe("signed.jwt.token");
    });

    it("rejects wrong passwords", async () => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          password: "wrong",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("OIDC users", () => {
    beforeEach(() => {
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        authProvider: "oidc",
        passwordHash: null,
        twoFactorSecret: null,
      });
      preferencesRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
    });

    it("rejects a password or nothing at all", async () => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", { password: "x" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // P2-005. This branch used to accept `oidcConfirmed: true` -- a boolean the
    // client sent -- so the step-up token, whose entire purpose is to be a second
    // proof, was issued on the strength of the session that already existed.
    it.each([
      ["the old sentinel", "oidc-session-confirmed"],
      ["any non-empty string", "x"],
      ["an unsigned JWT-shaped value", "a.b.c"],
    ])("refuses %s as re-authentication", async (_label, token) => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          oidcReauthToken: token,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("refuses an artifact minted for a different action", async () => {
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          oidcReauthToken: new OidcReauthService(undefined as never).issue(
            userId,
            "delete-data",
          ),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("issues a token for a verified re-authentication artifact", async () => {
      const result = await service.verifyAndIssue(userId, "emergency-access", {
        oidcReauthToken: new OidcReauthService(undefined as never).issue(
          userId,
          "emergency-access",
        ),
      });
      expect(result.stepUpToken).toBe("signed.jwt.token");
      const payload = jwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({
        sub: userId,
        type: "step_up",
        purpose: "emergency-access",
      });
    });
  });

  describe("local user with no password (incomplete onboarding)", () => {
    it("rejects with STEP_UP_FACTOR_UNAVAILABLE", async () => {
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        authProvider: "local",
        passwordHash: null,
        twoFactorSecret: null,
      });
      preferencesRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      await expect(
        service.verifyAndIssue(userId, "emergency-access", { password: "x" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("rate limiting", () => {
    beforeEach(async () => {
      const hash = await bcrypt.hash("hunter2", 4);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        authProvider: "local",
        passwordHash: hash,
        twoFactorSecret: null,
      });
      preferencesRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
    });

    it("locks out after 10 failed attempts", async () => {
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verifyAndIssue(userId, "emergency-access", {
            password: "wrong",
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      // 11th attempt -- even with the correct password -- should be locked out.
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          password: "hunter2",
        }),
      ).rejects.toThrow(/too many/i);
    });

    it("clears the attempt counter after a successful verification", async () => {
      // First a few failures
      for (let i = 0; i < 3; i++) {
        await service
          .verifyAndIssue(userId, "emergency-access", { password: "wrong" })
          .catch(() => undefined);
      }
      // Then a success
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          password: "hunter2",
        }),
      ).resolves.toBeDefined();

      // Counter is reset -- another 10 failures should be needed to lock out.
      for (let i = 0; i < 9; i++) {
        await service
          .verifyAndIssue(userId, "emergency-access", { password: "wrong" })
          .catch(() => undefined);
      }
      await expect(
        service.verifyAndIssue(userId, "emergency-access", {
          password: "hunter2",
        }),
      ).resolves.toBeDefined();
    });
  });
});
