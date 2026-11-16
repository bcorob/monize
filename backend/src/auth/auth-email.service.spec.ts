import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DataSource, FindOperator, QueryFailedError } from "typeorm";
import { BadRequestException, ConflictException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import {
  AuthEmailService,
  FORGOT_PASSWORD_SCOPE,
  VERIFICATION_EMAIL_SCOPE,
} from "./auth-email.service";
import { User } from "../users/entities/user.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { OAUTH_GRANT_REVOKER } from "./credential-revocation";
import { PasswordBreachService } from "./password-breach.service";
import { TokenService } from "./token.service";
import { hashToken } from "./crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  authAttemptCounterProvider,
  createAuthAttemptCounterMock,
  type AuthAttemptCounterMock,
} from "../test-helpers/auth-attempt-counter-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AuthEmailService", () => {
  let service: AuthEmailService;
  let attemptCounters: AuthAttemptCounterMock;
  let usersRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;
  let oauthProviderService: { revokeAllForUser: jest.Mock };
  let passwordBreachService: { isBreached: jest.Mock };
  let tokenService: { revokeAllUserRefreshTokens: jest.Mock };

  let configValues: Record<string, string>;

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    resetToken: null,
    resetTokenExpiry: null,
  };

  beforeEach(async () => {
    configValues = {};
    usersRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    trustedDevicesRepository = {
      delete: jest.fn(),
    };

    patRepository = { update: jest.fn() };
    oauthProviderService = { revokeAllForUser: jest.fn().mockResolvedValue(0) };

    passwordBreachService = {
      isBreached: jest.fn(),
    };

    tokenService = {
      revokeAllUserRefreshTokens: jest.fn(),
    };

    attemptCounters = createAuthAttemptCounterMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useValue: createScopedDbMocks([
            [User, usersRepository as never],
            [TrustedDevice, trustedDevicesRepository as never],
            [PersonalAccessToken, patRepository as never],
          ]).dataSource,
        },
        AuthEmailService,
        {
          provide: PasswordBreachService,
          useValue: passwordBreachService,
        },
        {
          provide: TokenService,
          useValue: tokenService,
        },
        authAttemptCounterProvider(attemptCounters),
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) =>
              key in configValues ? configValues[key] : fallback,
            ),
          },
        },
        { provide: OAUTH_GRANT_REVOKER, useValue: oauthProviderService },
      ],
    }).compile();

    service = module.get<AuthEmailService>(AuthEmailService);
  });

  describe("generateResetToken", () => {
    it("should return user and token when user exists with password", async () => {
      const user = { ...mockUser };
      usersRepository.findOne.mockResolvedValue(user);
      usersRepository.save.mockResolvedValue(user);

      const result = await service.generateResetToken("test@example.com");

      expect(result).not.toBeNull();
      expect(result!.user).toBe(user);
      expect(result!.token).toBeDefined();
      expect(typeof result!.token).toBe("string");
      expect(result!.token).toHaveLength(64); // 32 bytes hex

      // Verify hashed token was saved (not the raw token)
      expect(usersRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          resetToken: hashToken(result!.token),
          resetTokenExpiry: expect.any(Date),
        }),
      );

      // Verify expiry is approximately 1 hour from now
      const savedUser = usersRepository.save.mock.calls[0][0];
      const expiryTime = savedUser.resetTokenExpiry.getTime();
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      expect(Math.abs(expiryTime - oneHourFromNow)).toBeLessThan(5000);
    });

    it("should return null when user is not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.generateResetToken(
        "nonexistent@example.com",
      );

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("should return null when user has no passwordHash (OIDC-only)", async () => {
      const oidcUser = { ...mockUser, passwordHash: null };
      usersRepository.findOne.mockResolvedValue(oidcUser);

      const result = await service.generateResetToken("test@example.com");

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("generateResetToken for an SSO account with a password", () => {
    const ssoUser = { ...mockUser, authProvider: "oidc" };

    it("returns null while OIDC_ALLOW_PASSWORD_LOGIN is off", async () => {
      usersRepository.findOne.mockResolvedValue({ ...ssoUser });

      expect(await service.generateResetToken("test@example.com")).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("issues a token while OIDC_ALLOW_PASSWORD_LOGIN is on", async () => {
      configValues.OIDC_ALLOW_PASSWORD_LOGIN = "true";
      usersRepository.findOne.mockResolvedValue({ ...ssoUser });

      expect(
        await service.generateResetToken("test@example.com"),
      ).not.toBeNull();
    });
  });

  describe("resetPassword", () => {
    let mockExecute: jest.Mock;
    let mockReturning: jest.Mock;
    let mockAndWhere: jest.Mock;
    let mockWhere: jest.Mock;
    let mockSet: jest.Mock;
    let mockUpdate: jest.Mock;

    beforeEach(() => {
      mockExecute = jest.fn();
      mockReturning = jest.fn().mockReturnValue({ execute: mockExecute });
      mockAndWhere = jest.fn().mockReturnValue({ returning: mockReturning });
      mockWhere = jest.fn().mockReturnValue({ andWhere: mockAndWhere });
      mockSet = jest.fn().mockReturnValue({ where: mockWhere });
      mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

      usersRepository.createQueryBuilder.mockReturnValue({
        update: mockUpdate,
      });
    });

    it("redeems a token on an SSO account only while OIDC_ALLOW_PASSWORD_LOGIN is on", async () => {
      mockExecute.mockResolvedValue({ affected: 0, raw: [] });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await expect(
        service.resetPassword("t", "NewSecurePassword123!"),
      ).rejects.toThrow(BadRequestException);
      expect(mockAndWhere).toHaveBeenLastCalledWith(
        expect.stringContaining("authProvider <> 'oidc'"),
        expect.objectContaining({ oidcAllowed: false }),
      );

      configValues.OIDC_ALLOW_PASSWORD_LOGIN = "true";
      await expect(
        service.resetPassword("t", "NewSecurePassword123!"),
      ).rejects.toThrow(BadRequestException);
      expect(mockAndWhere).toHaveBeenLastCalledWith(
        expect.stringContaining("authProvider <> 'oidc'"),
        expect.objectContaining({ oidcAllowed: true }),
      );
    });

    it("should hash password, update user, and revoke refresh tokens on success", async () => {
      const userId = "user-1";
      mockExecute.mockResolvedValue({
        affected: 1,
        raw: [{ id: userId }],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);
      tokenService.revokeAllUserRefreshTokens.mockResolvedValue(undefined);

      await service.resetPassword("valid-token", "NewSecurePassword123!");

      // Verify breach check
      expect(passwordBreachService.isBreached).toHaveBeenCalledWith(
        "NewSecurePassword123!",
      );

      // Verify query builder chain
      expect(usersRepository.createQueryBuilder).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(User);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          passwordHash: expect.any(String),
          resetToken: null,
          resetTokenExpiry: null,
        }),
      );
      expect(mockWhere).toHaveBeenCalledWith("resetToken = :hashedToken", {
        hashedToken: hashToken("valid-token"),
      });
      expect(mockAndWhere).toHaveBeenCalledWith(
        expect.stringContaining("resetTokenExpiry > :now"),
        { now: expect.any(Date), oidcAllowed: false },
      );
      expect(mockReturning).toHaveBeenCalledWith("id");

      // Verify password was hashed with bcrypt
      const setArg = mockSet.mock.calls[0][0];
      const isValidHash = await bcrypt.compare(
        "NewSecurePassword123!",
        setArg.passwordHash,
      );
      expect(isValidHash).toBe(true);

      // Verify refresh tokens revoked
      expect(tokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        userId,
      );
    });

    it("revokes PATs, trusted devices, sessions and OAuth grants on success", async () => {
      // A reset revoked the web sessions only: a personal access token or an
      // MCP client's OAuth grant kept working for whoever held it.
      mockExecute.mockResolvedValue({ affected: 1, raw: [{ id: "user-1" }] });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await service.resetPassword("valid-token", "NewSecurePassword123!");

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
      expect(tokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        "user-1",
      );
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("revokes nothing when the token is invalid", async () => {
      mockExecute.mockResolvedValue({ affected: 0, raw: [] });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await expect(
        service.resetPassword("invalid-token", "NewPassword123!"),
      ).rejects.toThrow(BadRequestException);

      expect(patRepository.update).not.toHaveBeenCalled();
      expect(trustedDevicesRepository.delete).not.toHaveBeenCalled();
      expect(oauthProviderService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("reports a failed OAuth sweep instead of a clean reset", async () => {
      mockExecute.mockResolvedValue({ affected: 1, raw: [{ id: "user-1" }] });
      passwordBreachService.isBreached.mockResolvedValue(false);
      oauthProviderService.revokeAllForUser.mockRejectedValue(
        new Error("db down"),
      );

      await expect(
        service.resetPassword("valid-token", "NewPassword123!"),
      ).rejects.toThrow("db down");
    });

    it("clears the login lockout in the same statement that sets the password", async () => {
      // A reset is the owner's way out of a lockout somebody else can keep
      // renewing by failing a password once per window. Before, the counter and
      // the lock survived the reset, so the new password was refused too.
      mockExecute.mockResolvedValue({ affected: 1, raw: [{ id: "user-1" }] });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await service.resetPassword("valid-token", "NewSecurePassword123!");

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          failedLoginAttempts: 0,
          lockedUntil: null,
        }),
      );
    });

    it("should throw BadRequestException when password is breached", async () => {
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.resetPassword("some-token", "breached-password"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.resetPassword("some-token", "breached-password"),
      ).rejects.toThrow("This password has been found in a data breach");

      // Should not attempt any DB update
      expect(usersRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException when token is invalid or expired", async () => {
      mockExecute.mockResolvedValue({
        affected: 0,
        raw: [],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await expect(
        service.resetPassword("invalid-token", "NewPassword123!"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.resetPassword("invalid-token", "NewPassword123!"),
      ).rejects.toThrow("Invalid or expired reset token");

      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("should not revoke refresh tokens when no userId in result.raw", async () => {
      mockExecute.mockResolvedValue({
        affected: 1,
        raw: [],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await service.resetPassword("valid-token", "NewPassword123!");

      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });
  });

  describe("checkForgotPasswordEmailLimit", () => {
    it("should allow first request and set count to 1", async () => {
      await expect(
        service.checkForgotPasswordEmailLimit("test@example.com"),
      ).resolves.toBe(true);
    });

    it("should allow subsequent requests within the limit", async () => {
      await service.checkForgotPasswordEmailLimit("test@example.com");

      await expect(
        service.checkForgotPasswordEmailLimit("test@example.com"),
      ).resolves.toBe(true);
    });

    it("should block at the limit (3rd request)", async () => {
      for (let i = 0; i < 3; i++) {
        await service.checkForgotPasswordEmailLimit("test@example.com");
      }

      await expect(
        service.checkForgotPasswordEmailLimit("test@example.com"),
      ).resolves.toBe(false);
    });

    it("should normalize email case", async () => {
      await service.checkForgotPasswordEmailLimit("Test@Example.COM");
      await service.checkForgotPasswordEmailLimit("test@example.com");
      await service.checkForgotPasswordEmailLimit("TEST@EXAMPLE.COM");

      // All three count as the same email, so the 4th should be blocked
      await expect(
        service.checkForgotPasswordEmailLimit("test@example.com"),
      ).resolves.toBe(false);
    });

    // The scope and the key shape are the contract between replicas, and the
    // key is hashed because this table has no owner column: a plaintext key
    // would make it a list of who asked for a password reset.
    it("counts under the documented scope, keyed by the hashed address", async () => {
      await service.checkForgotPasswordEmailLimit("  Test@Example.COM ");

      expect(attemptCounters.increment).toHaveBeenCalledWith(
        FORGOT_PASSWORD_SCOPE,
        hashToken("test@example.com"),
        60 * 60 * 1000,
        // "fixed" here, unlike the lockout counters: three sends an hour is
        // three sends an hour, and a refused one must not extend the window.
        "fixed",
      );
      for (const [, key] of attemptCounters.increment.mock.calls) {
        expect(key).not.toContain("@");
      }
    });

    it("should reset and allow after window expires", async () => {
      for (let i = 0; i < 3; i++) {
        await service.checkForgotPasswordEmailLimit("test@example.com");
      }
      await expect(
        service.checkForgotPasswordEmailLimit("test@example.com"),
      ).resolves.toBe(false);

      const realDateNow = Date.now;
      const originalNow = Date.now();
      Date.now = jest.fn().mockReturnValue(
        originalNow + 60 * 60 * 1000 + 1, // 1 hour + 1ms
      );

      try {
        await expect(
          service.checkForgotPasswordEmailLimit("test@example.com"),
        ).resolves.toBe(true);
        // Count restarted at 1, so the next one is allowed too.
        await expect(
          service.checkForgotPasswordEmailLimit("test@example.com"),
        ).resolves.toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should track different emails independently", async () => {
      for (let i = 0; i < 3; i++) {
        await service.checkForgotPasswordEmailLimit("user1@example.com");
      }

      await expect(
        service.checkForgotPasswordEmailLimit("user1@example.com"),
      ).resolves.toBe(false);
      await expect(
        service.checkForgotPasswordEmailLimit("user2@example.com"),
      ).resolves.toBe(true);
    });

    // The reason the counter moved onto a row: this process never saw the
    // first three requests.
    it("refuses on a count another replica wrote", async () => {
      attemptCounters.rows.set(
        `${FORGOT_PASSWORD_SCOPE}\u0000${hashToken("elsewhere@example.com")}`,
        { count: 3, windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      );

      await expect(
        service.checkForgotPasswordEmailLimit("elsewhere@example.com"),
      ).resolves.toBe(false);
    });
  });

  describe("generateVerificationToken", () => {
    it("returns user and a raw token, storing only the hashed token with a 24h expiry", async () => {
      const user = { ...mockUser, emailVerified: false };
      usersRepository.findOne.mockResolvedValue(user);
      usersRepository.save.mockResolvedValue(user);

      const result =
        await service.generateVerificationToken("test@example.com");

      expect(result).not.toBeNull();
      expect(result!.user).toBe(user);
      expect(result!.token).toHaveLength(64); // 32 bytes hex

      expect(usersRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          emailVerificationToken: hashToken(result!.token),
          emailVerificationTokenExpiry: expect.any(Date),
        }),
      );

      const savedUser = usersRepository.save.mock.calls[0][0];
      const expiryTime = savedUser.emailVerificationTokenExpiry.getTime();
      const twentyFourHoursFromNow = Date.now() + 24 * 60 * 60 * 1000;
      expect(Math.abs(expiryTime - twentyFourHoursFromNow)).toBeLessThan(5000);
    });

    it("returns null when the user is not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result =
        await service.generateVerificationToken("nobody@example.com");

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("returns null when the account is already verified", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        emailVerified: true,
      });

      const result =
        await service.generateVerificationToken("test@example.com");

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("verifyEmail", () => {
    let mockExecute: jest.Mock;
    let mockAndWhere: jest.Mock;
    let mockWhere: jest.Mock;
    let mockSet: jest.Mock;
    let mockUpdate: jest.Mock;

    beforeEach(() => {
      mockExecute = jest.fn();
      mockAndWhere = jest.fn().mockReturnValue({ execute: mockExecute });
      mockWhere = jest.fn().mockReturnValue({ andWhere: mockAndWhere });
      mockSet = jest.fn().mockReturnValue({ where: mockWhere });
      mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
      usersRepository.createQueryBuilder.mockReturnValue({
        update: mockUpdate,
      });
    });

    it("marks the account verified and clears the token on a valid token", async () => {
      mockExecute.mockResolvedValue({ affected: 1 });

      await service.verifyEmail("valid-token");

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationTokenExpiry: null,
        }),
      );
      expect(mockWhere).toHaveBeenCalledWith(
        "emailVerificationToken = :hashedToken",
        { hashedToken: hashToken("valid-token") },
      );
      expect(mockAndWhere).toHaveBeenCalledWith(
        "emailVerificationTokenExpiry > :now",
        { now: expect.any(Date) },
      );
    });

    it("throws BadRequestException for an invalid or expired token", async () => {
      mockExecute.mockResolvedValue({ affected: 0 });

      await expect(service.verifyEmail("bad-token")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.verifyEmail("bad-token")).rejects.toThrow(
        "Invalid or expired verification link",
      );
    });
  });

  describe("checkVerificationEmailLimit", () => {
    it("allows the first 3 requests and blocks the 4th within the window", async () => {
      await expect(
        service.checkVerificationEmailLimit("v@example.com"),
      ).resolves.toBe(true);
      await expect(
        service.checkVerificationEmailLimit("v@example.com"),
      ).resolves.toBe(true);
      await expect(
        service.checkVerificationEmailLimit("v@example.com"),
      ).resolves.toBe(true);
      await expect(
        service.checkVerificationEmailLimit("v@example.com"),
      ).resolves.toBe(false);
    });

    it("resets and allows again after the window expires", async () => {
      for (let i = 0; i < 3; i++) {
        await service.checkVerificationEmailLimit("v2@example.com");
      }
      await expect(
        service.checkVerificationEmailLimit("v2@example.com"),
      ).resolves.toBe(false);

      const realDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(realDateNow() + 60 * 60 * 1000 + 1);
      try {
        await expect(
          service.checkVerificationEmailLimit("v2@example.com"),
        ).resolves.toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    });

    it("tracks different emails independently and normalizes case", async () => {
      await service.checkVerificationEmailLimit("A@Example.com");
      await service.checkVerificationEmailLimit("a@example.com");
      await service.checkVerificationEmailLimit("A@EXAMPLE.COM");

      await expect(
        service.checkVerificationEmailLimit("a@example.com"),
      ).resolves.toBe(false);
      await expect(
        service.checkVerificationEmailLimit("other@example.com"),
      ).resolves.toBe(true);
    });

    // A separate scope, so exhausting one endpoint's allowance never spends
    // the other's for the same address.
    it("counts under its own scope", async () => {
      await service.checkVerificationEmailLimit("v3@example.com");

      expect(attemptCounters.increment).toHaveBeenCalledWith(
        VERIFICATION_EMAIL_SCOPE,
        hashToken("v3@example.com"),
        60 * 60 * 1000,
        "fixed",
      );
    });

    it("does not share an allowance with forgot-password", async () => {
      for (let i = 0; i < 3; i++) {
        await service.checkVerificationEmailLimit("both@example.com");
      }

      await expect(
        service.checkForgotPasswordEmailLimit("both@example.com"),
      ).resolves.toBe(true);
    });
  });

  /**
   * An in-memory `users` table for the confirm path: `findOne` honours the
   * token, expiry and email predicates the service passes, and the UPDATE only
   * applies while the id, token hash and expiry still match -- the conditional
   * write that makes the link single-use. A call-recording mock could not tell
   * a second click from the first.
   */
  describe("confirmEmailChange", () => {
    type Row = {
      id: string;
      email: string | null;
      emailVerified: boolean;
      pendingEmail: string | null;
      emailChangeToken: string | null;
      emailChangeTokenExpiry: Date | null;
    };
    let rows: Row[];
    let failUpdateWith: unknown;

    const pendingRow = (overrides: Partial<Row> = {}): Row => ({
      id: "user-1",
      email: "old@example.com",
      emailVerified: false,
      pendingEmail: "new@example.com",
      emailChangeToken: hashToken("change-token"),
      emailChangeTokenExpiry: new Date(Date.now() + 60_000),
      ...overrides,
    });

    const matches = (row: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => {
        const actual = row[key as keyof Row];
        if (value instanceof FindOperator) {
          // MoreThan(now) is the only operator the service uses.
          return (
            actual instanceof Date && actual > (value.value as unknown as Date)
          );
        }
        return actual === value;
      });

    beforeEach(() => {
      rows = [pendingRow()];
      failUpdateWith = undefined;
      usersRepository.findOne.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
      );
      usersRepository.createQueryBuilder.mockImplementation(() => {
        let patch: Partial<Row> = {};
        const params: Record<string, unknown> = {};
        const chain = {
          update: () => chain,
          set: (values: Partial<Row>) => {
            patch = values;
            return chain;
          },
          where: (_sql: string, p: Record<string, unknown>) => {
            Object.assign(params, p);
            return chain;
          },
          andWhere: (_sql: string, p: Record<string, unknown>) => {
            Object.assign(params, p);
            return chain;
          },
          execute: async () => {
            if (failUpdateWith) throw failUpdateWith;
            const target = rows.find(
              (row) =>
                row.id === params.id &&
                row.emailChangeToken === params.hashedToken &&
                row.emailChangeTokenExpiry !== null &&
                row.emailChangeTokenExpiry > (params.now as Date),
            );
            if (!target) return { affected: 0 };
            Object.assign(target, patch);
            return { affected: 1 };
          },
        };
        return chain;
      });
    });

    it("moves the pending address into email, verifies it and clears the token", async () => {
      await service.confirmEmailChange("change-token");

      expect(rows[0]).toEqual({
        id: "user-1",
        email: "new@example.com",
        emailVerified: true,
        pendingEmail: null,
        emailChangeToken: null,
        emailChangeTokenExpiry: null,
      });
      // Other sessions must sign in again with the new address.
      expect(tokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("is single-use: a second click changes nothing and is refused", async () => {
      await service.confirmEmailChange("change-token");
      tokenService.revokeAllUserRefreshTokens.mockClear();

      await expect(service.confirmEmailChange("change-token")).rejects.toThrow(
        BadRequestException,
      );
      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("refuses an expired link and leaves the live email alone", async () => {
      rows = [pendingRow({ emailChangeTokenExpiry: new Date(Date.now() - 1) })];

      await expect(service.confirmEmailChange("change-token")).rejects.toThrow(
        "Invalid or expired email change link",
      );
      expect(rows[0].email).toBe("old@example.com");
      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("refuses a token that was replaced by a newer request", async () => {
      rows = [pendingRow({ emailChangeToken: hashToken("newer-token") })];

      await expect(service.confirmEmailChange("change-token")).rejects.toThrow(
        BadRequestException,
      );
      expect(rows[0].email).toBe("old@example.com");
    });

    it("re-checks uniqueness at confirmation time", async () => {
      rows = [
        pendingRow(),
        pendingRow({
          id: "user-2",
          email: "new@example.com",
          pendingEmail: null,
          emailChangeToken: null,
          emailChangeTokenExpiry: null,
        }),
      ];

      await expect(service.confirmEmailChange("change-token")).rejects.toThrow(
        ConflictException,
      );
      expect(rows[0].email).toBe("old@example.com");
      expect(rows[0].pendingEmail).toBe("new@example.com");
      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("answers a lost race on the unique index with 409, not a 500", async () => {
      failUpdateWith = new QueryFailedError("UPDATE users", [], {
        code: "23505",
      } as unknown as Error);

      await expect(service.confirmEmailChange("change-token")).rejects.toThrow(
        ConflictException,
      );
      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("does not swallow an unrelated database error", async () => {
      failUpdateWith = new QueryFailedError("UPDATE users", [], {
        code: "57014",
      } as unknown as Error);

      await expect(
        service.confirmEmailChange("change-token"),
      ).rejects.toBeInstanceOf(QueryFailedError);
    });
  });
});
