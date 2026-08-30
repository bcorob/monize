import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { BackupEncryptionService } from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { ConfigService } from "@nestjs/config";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("bcryptjs");

describe("BackupEncryptionService", () => {
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let passwordBreach: Record<string, jest.Mock>;
  let scopedDataSource: { transaction: jest.Mock };

  const userId = "user-1";

  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: userId,
      authProvider: "local",
      passwordHash: "bcrypt-hash",
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
      ...overrides,
    } as User;
  }

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((s: string) => `enc:${s}`),
      decrypt: jest.fn((s: string) => s.replace(/^enc:/, "")),
    };
    passwordBreach = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    scopedDataSource = createScopedDbMocks([[User, usersRepo as never]])
      .dataSource as unknown as { transaction: jest.Mock };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useValue: scopedDataSource,
        },
        BackupEncryptionService,
        { provide: EncryptionService, useValue: encryption },
        { provide: PasswordBreachService, useValue: passwordBreach },
      ],
    }).compile();

    service = module.get(BackupEncryptionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("getStatus", () => {
    it("reports a local user's encryption as enabled but not theirs to manage", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );
      // Their password is recaptured at every login, so Settings offers them
      // nothing to change.
      expect(await service.getStatus(userId)).toEqual({
        enabled: true,
        manageable: false,
        method: "login-password",
        available: true,
      });
    });

    it("reports an OIDC user's encryption as theirs to manage", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      expect(await service.getStatus(userId)).toEqual({
        enabled: false,
        manageable: true,
        method: "backup-password",
        available: true,
      });
    });

    it("throws when user not found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.getStatus(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("reports a server that cannot encrypt at all as unavailable", async () => {
      // "Off because this server holds no key" and "off because this user has
      // not turned it on" are two different facts with two different fixes, and
      // a screen that shows only `enabled` cannot tell them apart -- which is
      // how issue #1269 stayed invisible on the Settings page.
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      expect(await service.getStatus(userId)).toEqual({
        enabled: false,
        manageable: false,
        method: "login-password",
        available: false,
      });
    });
  });

  describe("enableWithLoginPassword", () => {
    it("stores the confirmed login password and turns encryption on", async () => {
      // The path that rescues a session older than the deploy which shipped the
      // capture: nothing else would ask this user for their password again, so
      // their backups would stay plaintext for the life of the session.
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.enableWithLoginPassword(userId, "hunter2hunter2");

      expect(bcrypt.compare).toHaveBeenCalledWith(
        "hunter2hunter2",
        "bcrypt-hash",
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupPasswordEnc: "enc:hunter2hunter2",
          backupEncryptionEnabled: true,
        },
      );
    });

    it("refuses a password that is not the account's, and writes nothing", async () => {
      // Storing an unverified string would encrypt every future backup under a
      // password the user only thinks they know -- a file that looks like a
      // backup and never opens.
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.enableWithLoginPassword(userId, "not-my-password"),
      ).rejects.toThrow(UnauthorizedException);

      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(encryption.encrypt).not.toHaveBeenCalled();
    });

    it("refuses an OIDC account, which has no login password of ours", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(BadRequestException);

      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the server holds no key, rather than storing something unreadable", async () => {
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(BadRequestException);

      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("throws when the user no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("rememberLoginPassword", () => {
    it("stores the encrypted password and turns encryption on", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());

      await service.rememberLoginPassword(userId, "hunter2hunter2");

      expect(encryption.encrypt).toHaveBeenCalledWith("hunter2hunter2");
      // A targeted update, not a full-entity save. `save` on a loaded entity
      // writes every column from the snapshot, so it silently reverted any
      // concurrent change to the users row -- `last_activity_at`, a lockout
      // counter, an admin disabling the account.
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupPasswordEnc: "enc:hunter2hunter2",
          backupEncryptionEnabled: true,
        },
      );
    });

    it("replaces a stored copy that no longer matches", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-password",
        }),
      );

      await service.rememberLoginPassword(userId, "new-password");

      // This runs during a password change, which writes `password_hash` on
      // the same row. A full-entity save from the snapshot read a moment
      // earlier could put the old hash back -- only the columns this feature
      // owns are written.
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        expect.objectContaining({ backupPasswordEnc: "enc:new-password" }),
      );
    });

    it("refreshes the stored copy even when it already matches", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:hunter2hunter2",
        }),
      );

      await service.rememberLoginPassword(userId, "hunter2hunter2");

      // Deliberately unconditional. Reading the stored copy back to compare it
      // means decrypting a secret and matching it against the supplied one,
      // which is a timing side channel with `===` (CWE-208) and an insecure
      // password hash with a digest -- both were flagged, and neither bought
      // anything, since every caller writes this row regardless.
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        expect.objectContaining({ backupPasswordEnc: "enc:hunter2hunter2" }),
      );
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("stores nothing for an OIDC account", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );

      await service.rememberLoginPassword(userId, "hunter2hunter2");

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("stores nothing when the server has no encryption key", async () => {
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      await service.rememberLoginPassword(userId, "hunter2hunter2");

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("stores nothing for a user that no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);

      await service.rememberLoginPassword(userId, "hunter2hunter2");

      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("swallows a storage failure rather than breaking sign-in", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      usersRepo.update.mockRejectedValue(new Error("db down"));

      await expect(
        service.rememberLoginPassword(userId, "hunter2hunter2"),
      ).resolves.toBeUndefined();
    });
  });

  describe("resolveBackupPassword", () => {
    it("returns 'none' when nothing is stored", async () => {
      expect(await service.resolveBackupPassword(makeUser())).toEqual({
        status: "none",
      });
    });

    it("returns the password when it still matches the login password", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.resolveBackupPassword(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:hunter2hunter2",
        }),
      );

      expect(result).toEqual({
        status: "password",
        password: "hunter2hunter2",
      });
    });

    it("drops a stale copy rather than encrypting with a password the user has changed", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-password",
        }),
      );

      const result = await service.resolveBackupPassword(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-password",
        }),
      );

      // A backup encrypted with a forgotten password is a file the user
      // cannot open; better an unencrypted one until the next sign-in.
      expect(result).toEqual({ status: "none" });
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
        },
      );
    });

    it("reports 'unrecoverable' when the stored copy cannot be decrypted", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });

      const result = await service.resolveBackupPassword(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:unreadable",
        }),
      );

      // Distinct from "none": the caller must refuse rather than silently
      // writing plaintext where it used to write ciphertext.
      expect(result).toEqual({ status: "unrecoverable" });
    });

    it("skips the login-password check for an OIDC account", async () => {
      const result = await service.resolveBackupPassword(
        makeUser({
          authProvider: "oidc",
          passwordHash: null,
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:dedicated",
        }),
      );

      expect(result).toEqual({ status: "password", password: "dedicated" });
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });
  });

  describe("setBackupPasswordForOidcUser", () => {
    function oidcUser(overrides: Partial<User> = {}) {
      return makeUser({
        authProvider: "oidc",
        passwordHash: null,
        ...overrides,
      });
    }

    it("stores the dedicated password and turns encryption on", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());

      await service.setBackupPasswordForOidcUser(userId, "a-strong-password");

      // Targeted update of the two owned columns, never a full-entity save.
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupPasswordEnc: "enc:a-strong-password",
          backupEncryptionEnabled: true,
        },
      );
    });

    it("replaces an existing dedicated password", async () => {
      usersRepo.findOne.mockResolvedValue(
        oidcUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-backup-password",
        }),
      );

      await service.setBackupPasswordForOidcUser(userId, "new-backup-password");

      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        expect.objectContaining({
          backupPasswordEnc: "enc:new-backup-password",
        }),
      );
    });

    it("refuses a local-auth account", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());

      // Their copy is recaptured at the next login, so accepting this would
      // store a password that is about to be overwritten.
      await expect(
        service.setBackupPasswordForOidcUser(userId, "a-strong-password"),
      ).rejects.toThrow(BadRequestException);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("rejects a password shorter than the minimum", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());

      await expect(
        service.setBackupPasswordForOidcUser(userId, "short"),
      ).rejects.toThrow(/at least 12/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("rejects a breached password", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());
      passwordBreach.isBreached.mockResolvedValue(true);

      await expect(
        service.setBackupPasswordForOidcUser(userId, "correct horse battery"),
      ).rejects.toThrow(/data breach/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the server has no encryption key", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());
      encryption.isConfigured.mockReturnValue(false);

      await expect(
        service.setBackupPasswordForOidcUser(userId, "a-strong-password"),
      ).rejects.toThrow(/JWT_SECRET/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("disableForOidcUser", () => {
    it("clears the stored password", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          authProvider: "oidc",
          passwordHash: null,
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:dedicated",
        }),
      );

      await service.disableForOidcUser(userId);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
        },
      );
    });

    it("refuses a local-auth account", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:hunter2hunter2",
        }),
      );

      // "Disabled" would be a lie: the next sign-in captures the password
      // again and turns it straight back on.
      await expect(service.disableForOidcUser(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("forgetStoredPassword", () => {
    it("clears the stored copy", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:whatever",
        }),
      );

      await service.forgetStoredPassword(userId);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
        },
      );
    });

    it("is a no-op for a user that no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.forgetStoredPassword(userId),
      ).resolves.toBeUndefined();
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  /**
   * Each of these methods used to read the users row in one transaction and
   * write it back in another, which is the read-modify-write the project's
   * transaction rule exists to forbid: between the two, any concurrent change
   * to the row was lost.
   */
  describe("read and write share one transaction", () => {
    it.each([
      [
        "setBackupPasswordForOidcUser",
        () =>
          service.setBackupPasswordForOidcUser(userId, "long-good-password"),
        () => makeUser({ authProvider: "oidc", passwordHash: null }),
      ],
      [
        "disableForOidcUser",
        () => service.disableForOidcUser(userId),
        () =>
          makeUser({
            authProvider: "oidc",
            passwordHash: null,
            backupEncryptionEnabled: true,
            backupPasswordEnc: "enc:dedicated",
          }),
      ],
      [
        "rememberLoginPassword",
        () => service.rememberLoginPassword(userId, "new-password"),
        () => makeUser({ backupEncryptionEnabled: true }),
      ],
      [
        "forgetStoredPassword",
        () => service.forgetStoredPassword(userId),
        () =>
          makeUser({
            backupEncryptionEnabled: true,
            backupPasswordEnc: "enc:whatever",
          }),
      ],
    ])("%s", async (_name, run, user) => {
      usersRepo.findOne.mockResolvedValue(user());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      scopedDataSource.transaction.mockClear();

      await run();

      // One transaction, so the checks above the write ran against the state
      // the write lands on. Two would mean the row could change in between.
      expect(scopedDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(usersRepo.update).toHaveBeenCalledTimes(1);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });
  });
});

/**
 * The defect issue #1269 was reported from, held against the real
 * `EncryptionService` rather than a double.
 *
 * Every test above provides a mock whose `isConfigured()` returns true, so none
 * of them can see what actually broke: the key was `AI_ENCRYPTION_KEY`, an
 * optional variable documented as being for cloud AI providers, and on a
 * deployment that configured none the capture returned early every time. The
 * suite stayed green while automatic backups were written in plaintext.
 *
 * Both variable names are exercised, because both are live: a new deployment
 * sets `ENCRYPTION_KEY`, and one that predates the rename keeps its
 * `AI_ENCRYPTION_KEY` and must go on capturing without re-keying a column.
 */
describe.each([
  ["ENCRYPTION_KEY", "e".repeat(40)],
  ["AI_ENCRYPTION_KEY", "a".repeat(40)],
])("BackupEncryptionService keyed by %s", (envVar, keyValue) => {
  const userId = "user-1";
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const scopedDataSource = createScopedDbMocks([[User, usersRepo as never]])
      .dataSource as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DataSource, useValue: scopedDataSource },
        BackupEncryptionService,
        // The real service, over an environment holding only this one variable.
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) =>
              key === envVar ? keyValue : (fallback ?? ""),
            ),
          },
        },
        {
          provide: PasswordBreachService,
          useValue: { isBreached: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get(BackupEncryptionService);
  });

  it("captures the login password, and resolves it back for the cron", async () => {
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      authProvider: "local",
      passwordHash: "bcrypt-hash",
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
    } as User);

    await service.rememberLoginPassword(userId, "hunter2hunter2");

    expect(usersRepo.update).toHaveBeenCalledTimes(1);
    const stored = usersRepo.update.mock.calls[0][1] as {
      backupPasswordEnc: string;
      backupEncryptionEnabled: boolean;
    };
    expect(stored.backupEncryptionEnabled).toBe(true);
    // Ciphertext, not the password -- and it opens again on the way to the cron,
    // which is the half that decides whether the backup is encrypted.
    expect(stored.backupPasswordEnc).not.toContain("hunter2hunter2");

    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    await expect(
      service.resolveBackupPassword({
        id: userId,
        authProvider: "local",
        passwordHash: "bcrypt-hash",
        backupEncryptionEnabled: true,
        backupPasswordEnc: stored.backupPasswordEnc,
      } as User),
    ).resolves.toEqual({ status: "password", password: "hunter2hunter2" });
  });

  it("reports encryption as available in the status the screen renders", async () => {
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      authProvider: "local",
      passwordHash: "bcrypt-hash",
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
    } as User);

    expect(await service.getStatus(userId)).toMatchObject({ available: true });
  });
});
