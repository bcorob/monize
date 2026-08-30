import { Test, TestingModule } from "@nestjs/testing";
import { BackupService } from "./backup.service";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { User } from "../users/entities/user.entity";
import { EncryptionService } from "../common/encryption/encryption.service";

/**
 * `BackupService` forwards, and forwards *verbatim*.
 *
 * Doubles are the right tool here and only here: the claim under test is that
 * each method hands its arguments to the component that owns the behaviour and
 * returns what came back, so a real collaborator would be testing that
 * collaborator instead. Everything about what the components actually do is
 * asserted against real instances in `backup.service.spec.ts`.
 *
 * Worth its own file because a facade fails quietly. A delegation that drops its
 * third argument, or swallows a rejection, or returns a fresh object instead of
 * the one it was given, looks exactly like a working delegation from the call
 * site -- and the auto-backup cron's `encryptionPassword` and the support
 * export's `skipTables` are both third arguments nothing else would have caught.
 */
describe("BackupService (facade)", () => {
  let service: BackupService;
  // Typed, so tsc rejects a return shape the real component cannot produce.
  let exportService: jest.Mocked<
    Pick<
      BackupExportService,
      | "exportToBuffer"
      | "streamExport"
      | "collectRawExport"
      | "getBackedUpTableNames"
      | "getIntentionallyExcludedTableNames"
    >
  > & { exportBufferLimitBytes: number };
  let restoreService: jest.Mocked<Pick<BackupRestoreService, "restoreData">> & {
    restoreExpandedLimitBytes: number;
  };
  let passwordCipher: { decrypt: jest.Mock };

  const userId = "11111111-1111-4111-8111-111111111111";
  const report = {
    complete: true,
    expectedAttachments: 0,
    includedAttachments: 0,
    missingAttachments: 0,
    inconsistentAttachments: 0,
  };

  beforeEach(async () => {
    exportService = {
      exportToBuffer: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from("gz"), report }),
      streamExport: jest.fn().mockResolvedValue(undefined),
      collectRawExport: jest.fn().mockResolvedValue({
        version: 1,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: { accounts: [] },
      }),
      getBackedUpTableNames: jest.fn().mockReturnValue(["accounts"]),
      getIntentionallyExcludedTableNames: jest.fn().mockReturnValue(["users"]),
      exportBufferLimitBytes: 1234,
    };
    restoreService = {
      restoreData: jest.fn().mockResolvedValue({
        message: "Backup restored successfully",
        restored: {},
      }),
      restoreExpandedLimitBytes: 5678,
    };
    passwordCipher = { decrypt: jest.fn(() => "stored-password") };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: EncryptionService, useValue: passwordCipher },
        { provide: BackupExportService, useValue: exportService },
        { provide: BackupRestoreService, useValue: restoreService },
      ],
    }).compile();

    service = module.get(BackupService);
  });

  it("reads both ceilings from the component that owns each", () => {
    // Crossed getters would have each path enforcing the other's limit, which no
    // behavioural test notices while both numbers are defaults.
    expect(service.exportBufferLimitBytes).toBe(1234);
    expect(service.restoreExpandedLimitBytes).toBe(5678);
  });

  it("passes the encryption password through to exportToBuffer", async () => {
    const result = await service.exportToBuffer(userId, "pw");

    expect(exportService.exportToBuffer).toHaveBeenCalledWith(userId, "pw");
    expect(result).toEqual({ buffer: Buffer.from("gz"), report });
  });

  it("omits the encryption password when the caller gave none", async () => {
    await service.exportToBuffer(userId);

    // `undefined`, not `""` or a default: the auto-backup path distinguishes
    // "encrypt with this" from "write plaintext".
    expect(exportService.exportToBuffer).toHaveBeenCalledWith(
      userId,
      undefined,
    );
  });

  it("passes the response and the password through to streamExport", async () => {
    const res = {} as import("express").Response;

    await service.streamExport(userId, res, "pw");

    expect(exportService.streamExport).toHaveBeenCalledWith(userId, res, "pw");
  });

  it("passes skipTables through to collectRawExport", async () => {
    const options = { skipTables: new Set(["attachment_blobs"]) };

    const result = await service.collectRawExport(userId, options);

    // The support export's whole reason for the option: a dropped third argument
    // fetches hundreds of megabytes of base64 and throws it away.
    expect(exportService.collectRawExport).toHaveBeenCalledWith(
      userId,
      options,
    );
    expect(result.tables).toEqual({ accounts: [] });
  });

  it("defaults collectRawExport's options to an empty object", async () => {
    await service.collectRawExport(userId);

    expect(exportService.collectRawExport).toHaveBeenCalledWith(userId, {});
  });

  it("forwards both table-name queries", () => {
    expect(service.getBackedUpTableNames()).toEqual(["accounts"]);
    expect(service.getIntentionallyExcludedTableNames()).toEqual(["users"]);
  });

  it("passes the whole restore input through to restoreData", async () => {
    const input = {
      compressedData: Buffer.from("gz"),
      password: "login",
      oidcIdToken: "artifact",
      backupPassword: "older",
    };

    const result = await service.restoreData(userId, input);

    // Every field matters: dropping `backupPassword` turns a restorable backup
    // into a password prompt, and dropping `oidcIdToken` turns an OIDC restore
    // into a 401.
    expect(restoreService.restoreData).toHaveBeenCalledWith(userId, input);
    expect(result.message).toBe("Backup restored successfully");
  });

  it("propagates a restore failure rather than swallowing it", async () => {
    restoreService.restoreData.mockRejectedValue(new Error("constraint"));

    await expect(
      service.restoreData(userId, { compressedData: Buffer.from("gz") }),
    ).rejects.toThrow("constraint");
  });

  it("resolves a stored backup password through the encryption service", () => {
    const user = {
      id: userId,
      backupEncryptionEnabled: true,
      backupPasswordEnc: "enc:stored",
    } as unknown as User;

    expect(service.resolveStoredBackupPassword(user)).toBe("stored-password");
    expect(passwordCipher.decrypt).toHaveBeenCalledWith("enc:stored");
  });

  it("returns null when the user has no stored backup password", () => {
    const user = {
      id: userId,
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
    } as unknown as User;

    expect(service.resolveStoredBackupPassword(user)).toBeNull();
    expect(passwordCipher.decrypt).not.toHaveBeenCalled();
  });
});
