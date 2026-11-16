import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { UsersService } from "../users/users.service";
import { EmailService } from "../notifications/email.service";
import { AttachmentsService } from "../attachments/attachments.service";
import { AutoBackupService } from "../backup/auto-backup.service";
import { encrypt, derivePurposeKey } from "../auth/crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * `AdminService.resetUserTwoFactor`: the recovery for a user locked out of
 * two-factor authentication, including everyone enrolled before a JWT_SECRET
 * change. Its own file because `admin.service.spec.ts` is already past the
 * repository's line ceiling.
 */
describe("AdminService.resetUserTwoFactor", () => {
  let service: AdminService;
  let usersRepository: Record<string, jest.Mock>;
  let preferences: UserPreferenceRepoMock;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock };

  /**
   * Encrypted under the key a different JWT_SECRET derives: what every
   * enrolled secret looks like after the secret changed. Nothing here can
   * decrypt it, which is the point -- the reset must not try.
   */
  const undecryptableSecret = encrypt(
    "TOTP_SECRET",
    derivePurposeKey(
      "the-jwt-secret-this-deployment-used-to-have",
      "totp-encryption",
    ),
  );

  const enrolledUser = (): Partial<User> => ({
    id: "user-2",
    email: "user@example.com",
    role: "user",
    twoFactorSecret: undecryptableSecret,
    pendingTwoFactorSecret: null,
    backupCodes: JSON.stringify(["$2a$04$hash"]),
  });

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn().mockResolvedValue(enrolledUser()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    preferences = createUserPreferenceRepoMock({
      userId: "user-2",
      twoFactorEnabled: true,
    });
    refreshTokensRepository = { update: jest.fn() };
    trustedDevicesRepository = { delete: jest.fn() };

    const scoped = createScopedDbMocks([
      [User, usersRepository],
      [UserPreference, preferences.repo],
      [RefreshToken, refreshTokensRepository],
      [TrustedDevice, trustedDevicesRepository],
    ]);
    dataSource = scoped.dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: OAuthProviderService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: I18nService, useValue: {} },
        { provide: AttachmentsService, useValue: {} },
        { provide: AutoBackupService, useValue: {} },
      ],
    }).compile();

    service = module.get(AdminService);
  });

  it("clears the TOTP secret, the staged secret and the backup codes without decrypting anything", async () => {
    await expect(
      service.resetUserTwoFactor("admin-1", "user-2"),
    ).resolves.toEqual({ reset: true });

    expect(usersRepository.update).toHaveBeenCalledWith(
      { id: "user-2" },
      {
        twoFactorSecret: null,
        pendingTwoFactorSecret: null,
        backupCodes: null,
      },
    );
    // Locked, so the "has 2FA" check and the write see one state.
    expect(usersRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: "pessimistic_write" } }),
    );
  });

  it("switches the preference flag off, touching only that column", async () => {
    await service.resetUserTwoFactor("admin-1", "user-2");

    expect(preferences.row()!.twoFactorEnabled).toBe(false);
    expect(preferences.patches()).toEqual([{ twoFactorEnabled: false }]);
  });

  it("deletes the user's trusted devices and revokes their refresh tokens", async () => {
    await service.resetUserTwoFactor("admin-1", "user-2");

    expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
      userId: "user-2",
    });
    expect(refreshTokensRepository.update).toHaveBeenCalledWith(
      { userId: "user-2", isRevoked: false },
      { isRevoked: true },
    );
  });

  it("does it all in one transaction", async () => {
    await service.resetUserTwoFactor("admin-1", "user-2");

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it("also resets a user whose only 2FA state is the preference flag", async () => {
    usersRepository.findOne.mockResolvedValue({
      ...enrolledUser(),
      twoFactorSecret: null,
      backupCodes: null,
    });

    await expect(
      service.resetUserTwoFactor("admin-1", "user-2"),
    ).resolves.toEqual({ reset: true });
  });

  it("refuses with a 400 and writes nothing for a user with no 2FA", async () => {
    usersRepository.findOne.mockResolvedValue({
      ...enrolledUser(),
      twoFactorSecret: null,
      backupCodes: null,
    });
    preferences.seed({ userId: "user-2", twoFactorEnabled: false });

    await expect(
      service.resetUserTwoFactor("admin-1", "user-2"),
    ).rejects.toThrow(BadRequestException);
    expect(usersRepository.update).not.toHaveBeenCalled();
    expect(trustedDevicesRepository.delete).not.toHaveBeenCalled();
    expect(refreshTokensRepository.update).not.toHaveBeenCalled();
  });

  it("refuses an admin resetting their own 2FA, before reading anything", async () => {
    await expect(
      service.resetUserTwoFactor("admin-1", "admin-1"),
    ).rejects.toThrow(ForbiddenException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown user", async () => {
    usersRepository.findOne.mockResolvedValue(null);

    await expect(
      service.resetUserTwoFactor("admin-1", "user-404"),
    ).rejects.toThrow(NotFoundException);
    expect(usersRepository.update).not.toHaveBeenCalled();
  });
});
