import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { UsersService } from "../users/users.service";
import { EmailService } from "../notifications/email.service";
import { AttachmentsService } from "../attachments/attachments.service";
import { AutoBackupService } from "../backup/auto-backup.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AdminService", () => {
  let service: AdminService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let oauthProviderService: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let attachmentsService: Record<string, jest.Mock>;
  let autoBackupService: Record<string, jest.Mock>;
  let transactionManager: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  /**
   * The admin set a test posits. The last-admin guard locks it with a raw
   * `SELECT id FROM users WHERE role = 'admin' FOR UPDATE`, because a count
   * cannot refuse two concurrent demotions of two different admins -- so the set
   * is driven through the manager's `query`, not through `usersRepository.count`.
   */
  const lockedAdmins = (...ids: string[]): void => {
    transactionManager.query.mockImplementation((sql: unknown) =>
      Promise.resolve(
        /FOR UPDATE/.test(String(sql)) ? ids.map((id) => ({ id })) : [],
      ),
    );
  };

  /**
   * Record the transaction boundaries and the credential writes in order, so a
   * test can tell "PATs revoked in the password's commit" from "in the next one"
   * and see the converging refresh revoke run after the commit (A26-L07,
   * A26-M02).
   */
  const recordCredentialOrder = (): string[] => {
    const order: string[] = [];
    const run = dataSource.transaction.getMockImplementation()!;
    dataSource.transaction.mockImplementation(async (...args: any[]) => {
      order.push("begin");
      const result = await run(...args);
      order.push("commit");
      return result;
    });
    usersRepository.save.mockImplementation(async (u: unknown) => {
      order.push("save");
      return u;
    });
    patRepository.update.mockImplementation(async () => {
      order.push("pats");
      return { affected: 0 };
    });
    transactionManager.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT DISTINCT family_id")) {
        order.push("converge");
      }
      return [];
    });
    oauthProviderService.revokeAllForUser.mockImplementation(async () => {
      order.push("oauth");
      return 0;
    });
    return order;
  };

  const mockAdmin = {
    id: "admin-1",
    email: "admin@example.com",
    firstName: "Admin",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "admin",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTargetUser = {
    id: "user-2",
    email: "user@example.com",
    firstName: "Regular",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    usersRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      remove: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    preferencesRepository = {
      delete: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };

    refreshTokensRepository = {
      update: jest.fn(),
      delete: jest.fn(),
    };

    patRepository = {
      update: jest.fn(),
      delete: jest.fn(),
    };

    oauthProviderService = {
      revokeAllForUser: jest.fn().mockResolvedValue(0),
    };

    trustedDevicesRepository = { delete: jest.fn() };

    usersService = {
      isActingDelegate: jest.fn().mockResolvedValue(false),
      purgeForDowngrade: jest.fn().mockResolvedValue(undefined),
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn().mockReturnValue("http://localhost:3000"),
    };

    attachmentsService = {
      summarizeUsageByUser: jest.fn().mockResolvedValue(new Map()),
    };

    autoBackupService = {
      summarizeStoredBackups: jest
        .fn()
        .mockResolvedValue({ enabled: false, artifacts: 0, bytes: 0 }),
    };

    transactionManager = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((_entity, data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) => ({
        id: data.id ?? "new-user-id",
        ...data,
      })),
    };

    // Every write now runs through `withScopedDb`, so the spec's
    // `transactionManager` IS the scoped transaction's EntityManager, and the
    // per-entity repositories are routed through its getRepository.
    const scoped = createScopedDbMocks([
      [User, usersRepository as never],
      [UserPreference, preferencesRepository as never],
      [RefreshToken, refreshTokensRepository as never],
      [PersonalAccessToken, patRepository as never],
      [TrustedDevice, trustedDevicesRepository as never],
    ]);
    Object.assign(scoped.manager, transactionManager);
    transactionManager = scoped.manager;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    // Three admins by default, so tests that are not about the guard are not
    // refused by it.
    lockedAdmins("admin-1", "admin-9", "user-2");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: OAuthProviderService,
          useValue: oauthProviderService,
        },
        {
          provide: UsersService,
          useValue: usersService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: EmailService,
          useValue: emailService,
        },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
        {
          provide: AttachmentsService,
          useValue: attachmentsService,
        },
        {
          provide: AutoBackupService,
          useValue: autoBackupService,
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe("getUserStorageUsage", () => {
    it("pairs each managed user with their backup and attachment usage", async () => {
      usersRepository.find.mockResolvedValue([
        { id: "admin-1" },
        { id: "user-2" },
      ]);
      attachmentsService.summarizeUsageByUser.mockResolvedValue(
        new Map([
          ["admin-1", { files: 3, bytes: 2048 }],
          ["user-2", { files: 1, bytes: 512 }],
        ]),
      );
      autoBackupService.summarizeStoredBackups.mockImplementation(
        (userId: string) =>
          Promise.resolve(
            userId === "admin-1"
              ? { enabled: true, artifacts: 7, bytes: 70_000 }
              : { enabled: false, artifacts: 1, bytes: 900 },
          ),
      );

      const result = await service.getUserStorageUsage();

      expect(result).toEqual([
        {
          userId: "admin-1",
          backups: { enabled: true, artifacts: 7, bytes: 70_000 },
          attachments: { files: 3, bytes: 2048 },
        },
        {
          userId: "user-2",
          backups: { enabled: false, artifacts: 1, bytes: 900 },
          attachments: { files: 1, bytes: 512 },
        },
      ]);
    });

    it("enumerates the same users the admin list does, so a delegate-only row has no storage line", async () => {
      usersRepository.find.mockResolvedValue([]);

      await service.getUserStorageUsage();

      expect(usersRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isDelegateOnly: false } }),
      );
    });

    it("reports zero -- not unknown -- for a user with no attachments", async () => {
      usersRepository.find.mockResolvedValue([{ id: "user-2" }]);
      attachmentsService.summarizeUsageByUser.mockResolvedValue(new Map());

      const [row] = await service.getUserStorageUsage();

      expect(row.attachments).toEqual({ files: 0, bytes: 0 });
    });

    it("keeps an unreadable backup store unknown rather than turning it into zero", async () => {
      usersRepository.find.mockResolvedValue([{ id: "user-2" }]);
      autoBackupService.summarizeStoredBackups.mockResolvedValue({
        enabled: true,
        artifacts: null,
        bytes: null,
      });

      const [row] = await service.getUserStorageUsage();

      expect(row.backups).toEqual({
        enabled: true,
        artifacts: null,
        bytes: null,
      });
    });

    it("asks the store once per user rather than once for the deployment", async () => {
      usersRepository.find.mockResolvedValue([
        { id: "admin-1" },
        { id: "user-2" },
      ]);

      await service.getUserStorageUsage();

      expect(autoBackupService.summarizeStoredBackups).toHaveBeenCalledTimes(2);
      expect(autoBackupService.summarizeStoredBackups).toHaveBeenCalledWith(
        "admin-1",
      );
      expect(autoBackupService.summarizeStoredBackups).toHaveBeenCalledWith(
        "user-2",
      );
      // One grouped aggregate covers every user's attachments.
      expect(attachmentsService.summarizeUsageByUser).toHaveBeenCalledTimes(1);
    });
  });

  describe("findAllUsers", () => {
    it("returns users with sensitive fields stripped", async () => {
      usersRepository.find.mockResolvedValue([mockAdmin, mockTargetUser]);

      const result = await service.findAllUsers();

      expect(result).toHaveLength(2);
      result.forEach((user) => {
        expect(user).not.toHaveProperty("passwordHash");
        expect(user).not.toHaveProperty("resetToken");
        expect(user).not.toHaveProperty("resetTokenExpiry");
        expect(user).not.toHaveProperty("twoFactorSecret");
        expect(user).toHaveProperty("hasPassword", true);
      });
    });

    it("sets hasPassword false for OIDC users without password", async () => {
      usersRepository.find.mockResolvedValue([
        { ...mockTargetUser, passwordHash: null, authProvider: "oidc" },
      ]);

      const result = await service.findAllUsers();

      expect(result[0].hasPassword).toBe(false);
    });

    it("hides owner-managed delegate identities and orders by createdAt ASC", async () => {
      usersRepository.find.mockResolvedValue([]);

      await service.findAllUsers();

      expect(usersRepository.find).toHaveBeenCalledWith({
        where: { isDelegateOnly: false },
        order: { createdAt: "ASC" },
      });
    });
  });

  describe("createUser", () => {
    it("creates a new full account with an admin-set password", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({
        email: "New@Example.com",
        firstName: "New",
        password: "Sup3rStr0ng!Pass",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.email).toBe("new@example.com");
      expect(savedUser.isDelegateOnly).toBe(false);
      expect(savedUser.authProvider).toBe("local");
      expect(savedUser.role).toBe("user");
      expect(savedUser.mustChangePassword).toBe(false);
      expect(savedUser.passwordHash).not.toBe("Sup3rStr0ng!Pass");
      expect(result.invited).toBe(false);
      expect(result.upgraded).toBe(false);
      expect(result.temporaryPassword).toBeUndefined();
      expect(result).not.toHaveProperty("passwordHash");
    });

    it("honors the requested admin role", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      await service.createUser({
        email: "boss@example.com",
        password: "Sup3rStr0ng!Pass",
        role: "admin",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.role).toBe("admin");
    });

    it("generates a temporary password when neither password nor invite is given", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({ email: "temp@example.com" });

      expect(result.temporaryPassword).toBeDefined();
      expect(typeof result.temporaryPassword).toBe("string");
      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(true);
      expect(savedUser.passwordHash).not.toBe(result.temporaryPassword);
    });

    it("sends an invite email and sets a 24h reset token when sendInvite is true", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({
        email: "invitee@example.com",
        firstName: "Invitee",
        sendInvite: true,
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.resetToken).toBeTruthy();
      expect(savedUser.resetTokenExpiry).toBeInstanceOf(Date);
      expect(savedUser.passwordHash).toBeUndefined();
      expect(result.invited).toBe(true);
      expect(result.temporaryPassword).toBeUndefined();
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "invitee@example.com",
        "Your Monize account is ready",
        expect.stringContaining("reset-password?token="),
      );
    });

    it("resolves the invite email language from the invitee's stored preference", async () => {
      transactionManager.findOne.mockResolvedValue(null);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "new-user-id",
        language: "fr",
      });

      await service.createUser({
        email: "invitee@example.com",
        firstName: "Invitee",
        sendInvite: true,
      });

      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "new-user-id" },
      });
    });

    it("rejects sendInvite when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });

      await expect(
        service.createUser({ email: "x@example.com", sendInvite: true }),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("rejects when both password and invite are supplied", async () => {
      await expect(
        service.createUser({
          email: "x@example.com",
          password: "Sup3rStr0ng!Pass",
          sendInvite: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("upgrades a pure delegate row into a full account, preserving the row id", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "delegate-1",
        email: "delegate@example.com",
        authProvider: "local",
        role: "user",
        isDelegateOnly: true,
        passwordHash: "$2a$10$existing",
      });

      const result = await service.createUser({
        email: "delegate@example.com",
        firstName: "Deleg",
        password: "Sup3rStr0ng!Pass",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.id).toBe("delegate-1");
      expect(savedUser.isDelegateOnly).toBe(false);
      expect(savedUser.firstName).toBe("Deleg");
      expect(result.upgraded).toBe(true);
      // No new row created -- the existing delegate row is reused.
      expect(transactionManager.create).not.toHaveBeenCalled();
    });

    it("rejects creating a user whose email is already a full account", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "real-1",
        email: "real@example.com",
        authProvider: "local",
        role: "user",
        isDelegateOnly: false,
        passwordHash: "$2a$10$existing",
      });

      await expect(
        service.createUser({
          email: "real@example.com",
          password: "Sup3rStr0ng!Pass",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("never rotates credentials of an OIDC delegate-only row", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "oidc-1",
        email: "sso@example.com",
        authProvider: "oidc",
        role: "user",
        isDelegateOnly: true,
      });

      await expect(
        service.createUser({
          email: "sso@example.com",
          password: "Sup3rStr0ng!Pass",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("updateUserRole", () => {
    it("updates role successfully", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.updateUserRole("admin-1", "user-2", "admin");

      expect(result.role).toBe("admin");
      expect(result).not.toHaveProperty("passwordHash");
    });

    it("throws ForbiddenException when changing own role", async () => {
      await expect(
        service.updateUserRole("admin-1", "admin-1", "user"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when target user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateUserRole("admin-1", "nonexistent", "admin"),
      ).rejects.toThrow(NotFoundException);
    });

    it("prevents removing the last admin", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      lockedAdmins("user-2");

      await expect(
        service.updateUserRole("admin-1", "user-2", "user"),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows demoting admin when other admins exist", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      lockedAdmins("user-2", "admin-9");

      const result = await service.updateUserRole("admin-1", "user-2", "user");

      expect(result.role).toBe("user");
    });
  });

  describe("updateUserStatus", () => {
    it("deactivates a user and revokes refresh tokens", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.updateUserStatus("admin-1", "user-2", false);

      expect(result.isActive).toBe(false);
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("activates a user without revoking tokens", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        isActive: false,
      });

      const result = await service.updateUserStatus("admin-1", "user-2", true);

      expect(result.isActive).toBe(true);
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("disables and revokes PATs in one commit, then converges the refresh sessions", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });
      const order = recordCredentialOrder();

      await service.updateUserStatus("admin-1", "user-2", false);

      const write = order.lastIndexOf("save");
      expect(order.slice(write - 1)).toEqual([
        "begin",
        "save",
        "pats",
        "commit",
        "begin",
        "converge",
        "commit",
        "oauth",
      ]);
    });

    it("revokes all PATs when deactivating a user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.updateUserStatus("admin-1", "user-2", false);

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes all OIDC artifacts when deactivating a user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.updateUserStatus("admin-1", "user-2", false);

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("does not revoke OIDC artifacts when activating a user", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        isActive: false,
      });

      await service.updateUserStatus("admin-1", "user-2", true);

      expect(oauthProviderService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("throws ForbiddenException when disabling own account", async () => {
      await expect(
        service.updateUserStatus("admin-1", "admin-1", false),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when target not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateUserStatus("admin-1", "nonexistent", false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteUser", () => {
    it("deletes preferences then user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(preferencesRepository.delete).toHaveBeenCalledWith({
        userId: "user-2",
      });
      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("throws ForbiddenException when deleting own account", async () => {
      await expect(service.deleteUser("admin-1", "admin-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws NotFoundException when target not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteUser("admin-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("prevents deleting the last admin", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      lockedAdmins("user-2");

      await expect(service.deleteUser("admin-1", "user-2")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("allows deleting admin when other admins exist", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      lockedAdmins("user-2", "admin-9");

      await service.deleteUser("admin-1", "user-2");

      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("locks the admin set again in the transaction that removes the row", async () => {
      // The guard used to run in its own transaction and commit before the
      // delete began, so the lock protected nothing by the time the row went.
      // Two admins deleted concurrently could each pass and leave none.
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      lockedAdmins("user-2", "admin-9");

      await service.deleteUser("admin-1", "user-2");

      const locks = transactionManager.query.mock.calls.filter((call) =>
        /FOR UPDATE/.test(String(call[0])),
      );
      expect(locks.length).toBeGreaterThanOrEqual(2);
    });

    it("refuses in the delete transaction when the admin set shrank after the pre-flight", async () => {
      // The pre-flight sees two admins; by the time the delete transaction takes
      // the lock the other admin is gone. The row must survive.
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      let seen = 0;
      transactionManager.query.mockImplementation((sql: unknown) => {
        if (!/FOR UPDATE/.test(String(sql))) return Promise.resolve([]);
        seen += 1;
        return Promise.resolve(
          seen === 1
            ? [{ id: "user-2" }, { id: "admin-9" }]
            : [{ id: "user-2" }],
        );
      });

      await expect(service.deleteUser("admin-1", "user-2")).rejects.toThrow(
        BadRequestException,
      );
      expect(usersRepository.remove).not.toHaveBeenCalled();
    });

    it("revokes all OIDC artifacts on delete", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("revokes refresh tokens and PATs on delete", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("deletes sessions and tokens so a non-cascading FK cannot block the delete", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        userId: "user-2",
      });
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        actingAsUserId: "user-2",
      });
      expect(patRepository.delete).toHaveBeenCalledWith({ userId: "user-2" });
    });

    it("demotes a delegate to a pure delegate instead of deleting", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });
      usersService.isActingDelegate.mockResolvedValue(true);

      await service.deleteUser("admin-1", "user-2");

      expect(usersService.purgeForDowngrade).toHaveBeenCalledWith("user-2");
      expect(preferencesRepository.delete).not.toHaveBeenCalled();
      expect(usersRepository.remove).not.toHaveBeenCalled();
      // The account survives as a delegate, so its sessions are revoked, not
      // deleted along with the row.
      expect(refreshTokensRepository.delete).not.toHaveBeenCalled();
      expect(patRepository.delete).not.toHaveBeenCalled();
      // Sessions are still revoked so the demotion takes effect immediately.
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });
  });

  describe("resetUserPassword", () => {
    it("generates a temporary password and sets mustChangePassword", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.resetUserPassword("admin-1", "user-2");

      expect(result.temporaryPassword).toBeDefined();
      expect(typeof result.temporaryPassword).toBe("string");
      expect(result.temporaryPassword.length).toBeGreaterThan(8);

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(true);
      expect(savedUser.resetToken).toBeNull();
      expect(savedUser.resetTokenExpiry).toBeNull();
      // Password should be hashed, not plaintext
      expect(savedUser.passwordHash).not.toBe(result.temporaryPassword);
    });

    it("clears a login lockout so the temporary password works", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        failedLoginAttempts: 25,
        lockedUntil: new Date(Date.now() + 4 * 60 * 60 * 1000),
      });

      await service.resetUserPassword("admin-1", "user-2");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.failedLoginAttempts).toBe(0);
      expect(savedUser.lockedUntil).toBeNull();
    });

    it("revokes all refresh tokens after password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes PATs in the password's own commit and converges the refresh sessions after it", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });
      const order = recordCredentialOrder();

      await service.resetUserPassword("admin-1", "user-2");

      const write = order.lastIndexOf("save");
      expect(order.slice(write - 1)).toEqual([
        "begin",
        "save",
        "pats",
        "commit",
        "begin",
        "converge",
        "commit",
        "oauth",
      ]);
    });

    it("revokes all PATs on password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes trusted devices on password reset", async () => {
      // A trusted-device cookie skips 2FA; it must not outlive the password an
      // administrator just replaced.
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-2",
      });
    });

    it("revokes all OIDC artifacts on password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("throws ForbiddenException when resetting own password", async () => {
      await expect(
        service.resetUserPassword("admin-1", "admin-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resetUserPassword("admin-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException for accounts without local password", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        passwordHash: null,
        authProvider: "oidc",
      });

      await expect(
        service.resetUserPassword("admin-1", "user-2"),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses an SSO account when local auth is off", async () => {
      configService.get.mockImplementation((key: string, def?: string) =>
        key === "LOCAL_AUTH_ENABLED" ? "false" : def,
      );
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        authProvider: "oidc",
      });

      await expect(
        service.resetUserPassword("admin-1", "user-2"),
      ).rejects.toThrow("Password sign-in is turned off on this server");
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("refuses an SSO account while password sign-in is off for SSO accounts", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        authProvider: "oidc",
      });

      await expect(
        service.resetUserPassword("admin-1", "user-2"),
      ).rejects.toThrow("Password sign-in is turned off for SSO accounts");
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("resets an SSO account's password when the flag allows it", async () => {
      configService.get.mockImplementation((key: string, def?: string) =>
        key === "OIDC_ALLOW_PASSWORD_LOGIN" ? "true" : def,
      );
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        authProvider: "oidc",
      });

      await service.resetUserPassword("admin-1", "user-2");

      expect(usersRepository.save).toHaveBeenCalled();
    });
  });

  describe("unlinkUserSso", () => {
    const ssoUser = () => ({
      ...mockTargetUser,
      authProvider: "oidc",
      passwordHash: null,
      oidcSubject: "sub-1",
      pendingOidcSubject: "sub-2",
      oidcLinkPending: true,
      oidcLinkToken: "tok",
      oidcLinkExpiresAt: new Date(),
    });

    it("converts to a local account with a temporary password and revokes like reset", async () => {
      usersRepository.findOne.mockResolvedValue(ssoUser());

      const result = await service.unlinkUserSso("admin-1", "user-2");

      expect(result.temporaryPassword.length).toBeGreaterThan(8);
      const saved = usersRepository.save.mock.calls[0][0];
      expect(saved.authProvider).toBe("local");
      expect(saved.oidcSubject).toBeNull();
      expect(saved.pendingOidcSubject).toBeNull();
      expect(saved.oidcLinkPending).toBe(false);
      expect(saved.oidcLinkToken).toBeNull();
      expect(saved.oidcLinkExpiresAt).toBeNull();
      expect(saved.mustChangePassword).toBe(true);
      expect(saved.passwordHash).not.toBe(result.temporaryPassword);
      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-2",
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("reads the row under a write lock", async () => {
      usersRepository.findOne.mockResolvedValue(ssoUser());

      await service.unlinkUserSso("admin-1", "user-2");

      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { id: "user-2" },
        lock: { mode: "pessimistic_write" },
      });
    });

    it("clears a backup key held under a dedicated backup password", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...ssoUser(),
        backupEncryptionEnabled: true,
        backupKeyEnc: "enc:key",
        backupKeyWrap: "wrap",
        backupKeyPasswordRef: null,
      });

      await service.unlinkUserSso("admin-1", "user-2");

      const saved = usersRepository.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        backupEncryptionEnabled: false,
        backupKeyEnc: null,
        backupKeyWrap: null,
        backupKeyPasswordRef: null,
      });
    });

    it("refuses an account with no email address and writes nothing", async () => {
      usersRepository.findOne.mockResolvedValue({ ...ssoUser(), email: null });
      await expect(service.unlinkUserSso("admin-1", "user-2")).rejects.toThrow(
        "no email address",
      );
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("refuses when local auth is turned off, before any read", async () => {
      configService.get.mockImplementation((key: string, def?: string) =>
        key === "LOCAL_AUTH_ENABLED" ? "false" : def,
      );
      await expect(service.unlinkUserSso("admin-1", "user-2")).rejects.toThrow(
        "Password sign-in is turned off on this server",
      );
      expect(usersRepository.findOne).not.toHaveBeenCalled();
    });

    it("refuses to unlink the caller's own account", async () => {
      await expect(service.unlinkUserSso("admin-1", "admin-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      await expect(
        service.unlinkUserSso("admin-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException for a non-SSO account and writes nothing", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });
      await expect(service.unlinkUserSso("admin-1", "user-2")).rejects.toThrow(
        BadRequestException,
      );
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });
});
