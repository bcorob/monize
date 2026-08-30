import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { EmergencyAccessService } from "./emergency-access.service";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { EmailService } from "../notifications/email.service";
import { User } from "../users/entities/user.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("EmergencyAccessService", () => {
  let service: EmergencyAccessService;
  let settingsRepo: Record<string, jest.Mock>;
  let contactsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: Record<string, jest.Mock>;
  };
  let dataSource: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    settingsRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    contactsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      create: jest.fn((row) => row),
      createQueryBuilder: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((s) => `enc(${s})`),
      decrypt: jest.fn((s) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
    };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
    };

    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        create: jest.fn((_entity, row) => row),
        save: jest.fn((row) => row),
        createQueryBuilder: jest.fn(() => updateBuilder),
      },
    };
    // Every read/write now runs through `withScopedDb`; the former QueryRunner
    // is the transaction's EntityManager, so keep `queryRunner.manager` pointing
    // at the same jest.fn()s the manager exposes.
    const scoped = createScopedDbMocks([
      [EmergencyAccessSettings, settingsRepo as never],
      [EmergencyAccessContact, contactsRepo as never],
      [User, usersRepo as never],
    ]);
    Object.assign(scoped.manager, queryRunner.manager);
    queryRunner.manager = scoped.manager;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmergencyAccessService,
        { provide: EncryptionService, useValue: encryption },
        { provide: EmailService, useValue: emailService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(EmergencyAccessService);
  });

  describe("getView", () => {
    it("returns defaults and emailConfigured=true when no settings row exists", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);

      expect(view.emailConfigured).toBe(true);
      expect(view.enabled).toBe(false);
      expect(view.grantAfterDays).toBe(14);
      expect(view.reminderAfterDays).toBe(7);
      expect(view.messageMetadata).toEqual({
        hasMessage: false,
        charCount: 0,
        updatedAt: null,
      });
      expect(view.contacts).toEqual([]);
    });

    it("never exposes the plaintext message via the view", async () => {
      const updatedAt = new Date("2026-05-01T00:00:00Z");
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(hello world)",
        lastReminderSentAt: null,
        grantedAt: null,
        updatedAt,
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(
        (view as unknown as Record<string, unknown>).message,
      ).toBeUndefined();
      expect(view.messageMetadata).toEqual({
        hasMessage: true,
        charCount: "hello world".length,
        updatedAt,
      });
    });

    it("returns emailConfigured=false when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.emailConfigured).toBe(false);
    });

    /**
     * The two configuration halves fail independently, and the second one fails
     * *silently* (audit RRV4-003): grant delivery stores each contact's claim token
     * encrypted so a retry re-sends the same link, and without a key that store
     * throws for every contact -- no email, one log line per contact, and a
     * settings page that still reports the safeguard as armed. The view has to
     * carry both, or the UI cannot say which one is missing.
     */
    it("reports credential-encryption readiness separately from SMTP", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });
      encryption.isConfigured.mockReturnValue(false);

      const view = await service.getView(userId);

      expect(view.emailConfigured).toBe(true);
      expect(view.credentialEncryptionConfigured).toBe(false);
    });

    it("reports credential encryption as ready when the key is present", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);

      expect(view.credentialEncryptionConfigured).toBe(true);
    });
  });

  describe("getMessage", () => {
    it("returns the decrypted message", async () => {
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        messageCiphertext: "enc(hello)",
      });
      await expect(service.getMessage(userId)).resolves.toEqual({
        message: "hello",
      });
      expect(encryption.decrypt).toHaveBeenCalledWith("enc(hello)");
    });

    it("returns null when no message is set", async () => {
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        messageCiphertext: null,
      });
      await expect(service.getMessage(userId)).resolves.toEqual({
        message: null,
      });
    });

    it("returns null when the row is missing entirely", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      await expect(service.getMessage(userId)).resolves.toEqual({
        message: null,
      });
    });

    it("returns null when decrypt throws", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        messageCiphertext: "enc(corrupt)",
      });
      await expect(service.getMessage(userId)).resolves.toEqual({
        message: null,
      });
    });
  });

  describe("updateMessage", () => {
    it("encrypts and stores a non-empty message", async () => {
      queryRunner.manager.findOne.mockResolvedValue({
        ownerUserId: userId,
        messageCiphertext: null,
        updatedAt: new Date("2026-05-01T00:00:00Z"),
      });

      const meta = await service.updateMessage(userId, "hello");

      expect(encryption.encrypt).toHaveBeenCalledWith("hello");
      const saved = queryRunner.manager.save.mock.calls[0][0];
      expect(saved.messageCiphertext).toBe("enc(hello)");
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(meta.hasMessage).toBe(true);
      expect(meta.charCount).toBe("hello".length);
    });

    it("clears the ciphertext when message is empty or whitespace", async () => {
      queryRunner.manager.findOne.mockResolvedValue({
        ownerUserId: userId,
        messageCiphertext: "enc(stale)",
      });

      const meta = await service.updateMessage(userId, "   ");

      const saved = queryRunner.manager.save.mock.calls[0][0];
      expect(saved.messageCiphertext).toBeNull();
      expect(meta.hasMessage).toBe(false);
    });

    it("creates a new row when none exists", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);

      await service.updateMessage(userId, "hi");

      expect(queryRunner.manager.create).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("refuses to save a non-empty message when ENCRYPTION_KEY is missing", async () => {
      encryption.isConfigured.mockReturnValue(false);
      await expect(
        service.updateMessage(userId, "secret"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("rolls back on error", async () => {
      queryRunner.manager.findOne.mockRejectedValueOnce(new Error("boom"));
      await expect(service.updateMessage(userId, "hello")).rejects.toThrow(
        "boom",
      );
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("upsertSettings", () => {
    it("refuses to save when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    /**
     * `.env.example` presents `ENCRYPTION_KEY` as optional, needed only for
     * cloud AI providers, so an SMTP-only self-hosted install without it is the
     * documented configuration rather than an edge case. Grant delivery now
     * requires it, and the failure is invisible: `credentialFor` throws per
     * contact, `notifyGrantContacts` reports zero deliveries, the grant is
     * released for tomorrow, and tomorrow repeats it forever. So enabling has to
     * be refused where the user can see it (audit RRV4-003).
     */
    it("refuses to enable when credential encryption is not configured", async () => {
      encryption.isConfigured.mockReturnValue(false);

      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // A refused command must not already have written.
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("names the missing key in the refusal", async () => {
      encryption.isConfigured.mockReturnValue(false);

      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toThrow(/ENCRYPTION_KEY/);
    });

    it("still lets the owner turn the feature off without SMTP", async () => {
      // Disabling is the one action that must never be blocked by a missing
      // dependency -- it is how an owner revokes a safeguard after SMTP was removed,
      // and it voids the outstanding links (audit V4R3-002).
      emailService.getStatus.mockReturnValue({ configured: false });
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      await service.upsertSettings(userId, {
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(stored.enabled).toBe(false);
    });

    it("still lets the owner turn the feature off without the key", async () => {
      // Otherwise an installation that lost its key could not disable a feature
      // that no longer works -- the refusal is about arming a safeguard that
      // cannot fire, not about editing the row.
      encryption.isConfigured.mockReturnValue(false);
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      await service.upsertSettings(userId, {
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(stored.enabled).toBe(false);
    });

    it("does not touch the existing ciphertext when saving settings", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(unchanged)",
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      await service.upsertSettings(userId, {
        enabled: true,
        grantAfterDays: 30,
        reminderAfterDays: 7,
      });

      expect(encryption.encrypt).not.toHaveBeenCalled();
      expect(stored.messageCiphertext).toBe("enc(unchanged)");
      expect(stored.enabled).toBe(true);
      expect(stored.grantAfterDays).toBe(30);
    });

    it("rolls back on error", async () => {
      queryRunner.manager.findOne.mockRejectedValueOnce(new Error("boom"));
      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toThrow("boom");
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("contact CRUD", () => {
    it("addContact rejects duplicate email (case-insensitive)", async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "existing" }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.addContact(userId, {
          firstName: "Alice",
          email: "Alice@Example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("addContact saves a new row", async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);
      contactsRepo.save.mockImplementation((row) => ({
        id: "new",
        createdAt: new Date(),
        ...row,
      }));

      const created = await service.addContact(userId, {
        firstName: " Alice ",
        email: " alice@example.com ",
      });

      expect(created.firstName).toBe("Alice");
      expect(created.email).toBe("alice@example.com");
      expect(contactsRepo.save).toHaveBeenCalled();
    });

    it("updateContact throws NotFoundException when missing", async () => {
      contactsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateContact(userId, "00000000-0000-0000-0000-000000000000", {
          firstName: "X",
          email: "x@example.com",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("removeContact throws NotFoundException when nothing was deleted", async () => {
      contactsRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.removeContact(userId, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("removeContact resolves when a row was deleted", async () => {
      contactsRepo.delete.mockResolvedValue({ affected: 1 });
      await expect(
        service.removeContact(userId, "00000000-0000-0000-0000-000000000000"),
      ).resolves.toBeUndefined();
    });

    it("updateContact updates fields and clears the in-flight magic link", async () => {
      const existing = {
        id: "c1",
        ownerUserId: userId,
        firstName: "Old",
        email: "old@example.com",
        claimTokenHash: "stale-hash",
        claimTokenExpiresAt: new Date(),
      };
      contactsRepo.findOne.mockResolvedValue(existing);
      contactsRepo.save.mockImplementation(async (row) => row);
      contactsRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      const result = await service.updateContact(userId, "c1", {
        firstName: " New ",
        email: " new@example.com ",
      });

      expect(result.firstName).toBe("New");
      expect(result.email).toBe("new@example.com");
      expect(existing.claimTokenHash).toBeNull();
      expect(existing.claimTokenExpiresAt).toBeNull();
    });

    it("updateContact skips the dup-check when the email is unchanged", async () => {
      const existing = {
        id: "c1",
        ownerUserId: userId,
        firstName: "Old",
        email: "old@example.com",
        claimTokenHash: null,
        claimTokenExpiresAt: null,
      };
      contactsRepo.findOne.mockResolvedValue(existing);
      contactsRepo.save.mockImplementation(async (row) => row);

      await service.updateContact(userId, "c1", {
        firstName: "Renamed",
        email: "OLD@example.com",
      });

      expect(contactsRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(existing.firstName).toBe("Renamed");
    });

    it("updateContact leaves a renamed contact owed a link for the current cycle", async () => {
      // The token clear was unconditional while the delivery markers were reset
      // only when the *email* changed, so correcting a typo in a contact's first
      // name during an active grant destroyed their working link and left
      // `notified_grant_generation` still claiming they had been served. They then
      // dropped out of `contactsAwaitingNotice` for the rest of the cycle: a
      // contact silently owed a link nobody would ever send, which is the exact
      // failure the generation exists to prevent. Clearing the hash and clearing
      // the markers are one decision.
      const existing = {
        id: "c1",
        ownerUserId: userId,
        firstName: "Old",
        email: "old@example.com",
        claimTokenHash: "a-delivered-hash",
        claimTokenExpiresAt: new Date(),
        claimTokenCiphertext: "enc(token)",
        claimNotifiedAt: new Date(),
        notifiedGrantGeneration: 4,
      };
      contactsRepo.findOne.mockResolvedValue(existing);
      contactsRepo.save.mockImplementation(async (row) => row);

      await service.updateContact(userId, "c1", {
        firstName: "Corrected",
        email: "old@example.com",
      });

      expect(existing.claimTokenHash).toBeNull();
      expect(existing.claimTokenCiphertext).toBeNull();
      expect(existing.claimNotifiedAt).toBeNull();
      expect(existing.notifiedGrantGeneration).toBeNull();
    });

    it("updateContact rejects swapping to an email already used by another row", async () => {
      contactsRepo.findOne.mockResolvedValue({
        id: "c1",
        ownerUserId: userId,
        email: "old@example.com",
      });
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "c2" }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.updateContact(userId, "c1", {
          firstName: "X",
          email: "Other@Example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("messageMetadata edge cases", () => {
    it("reports no message and updatedAt=null when the encryption key is unavailable", async () => {
      encryption.isConfigured.mockReturnValue(false);
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(hello)",
        updatedAt: new Date("2026-05-01T00:00:00Z"),
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.messageMetadata).toEqual({
        hasMessage: false,
        charCount: 0,
        updatedAt: null,
      });
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("reports no message when decrypt throws", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.messageMetadata.hasMessage).toBe(false);
    });

    it("returns no message when decrypt throws a non-Error value", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw "raw-string-not-an-Error";
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.messageMetadata.hasMessage).toBe(false);
    });
  });

  describe("getView lastActivityAt resolution", () => {
    it("returns the user's lastActivityAt when set", async () => {
      const t = new Date("2026-01-01T00:00:00Z");
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        lastActivityAt: t,
        lastLogin: null,
      });

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBe(t);
    });

    it("falls back to lastLogin when lastActivityAt is null", async () => {
      const t = new Date("2026-01-01T00:00:00Z");
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        lastActivityAt: null,
        lastLogin: t,
      });

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBe(t);
    });

    it("returns null when the user row itself is missing", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue(null);

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBeNull();
    });

    it("maps stored contact rows into the contact view shape", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.contacts).toEqual([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
    });
  });

  describe("upsertSettings: side effects", () => {
    it("voids outstanding magic links and clears markers when owner disables", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });
      contactsRepo.find.mockResolvedValue([]);

      const builder = queryRunner.manager.createQueryBuilder();
      await service.upsertSettings(userId, {
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(builder.update).toHaveBeenCalledWith(EmergencyAccessContact);
      const setArgs = builder.set.mock.calls[0][0];
      expect(typeof setArgs.claimTokenUsedAt).toBe("function");
      expect(setArgs.claimTokenUsedAt()).toBe("CURRENT_TIMESTAMP");
      expect(setArgs.claimVoidedReason).toBe("owner_revoked");
      expect(stored.grantedAt).toBeNull();
      expect(stored.lastReminderSentAt).toBeNull();
    });

    it("resets markers when the owner re-enables after a previous disable", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });
      contactsRepo.find.mockResolvedValue([]);

      await service.upsertSettings(userId, {
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(stored.grantedAt).toBeNull();
      expect(stored.lastReminderSentAt).toBeNull();
    });
  });

  describe("resetGrantedState", () => {
    it("throws when no settings row exists", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      await expect(service.resetGrantedState(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("clears grant markers and voids outstanding tokens", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      settingsRepo.findOne
        .mockResolvedValueOnce(stored)
        .mockResolvedValueOnce({ ...stored, grantedAt: null });
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(updateBuilder);
      const settingsBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      settingsRepo.createQueryBuilder.mockReturnValue(settingsBuilder);

      const view = await service.resetGrantedState(userId);

      // A targeted UPDATE of the two markers, not a re-save of the row read above.
      // The entity carries `grant_generation`, a counter only `claimGrant` may
      // advance -- and `save` writes back every column whose loaded value differs
      // from the row TypeORM reloads at persist time, so a bump landing between the
      // read and the write would be written back *down*.
      expect(settingsRepo.save).not.toHaveBeenCalled();
      expect(settingsBuilder.set).toHaveBeenCalledWith({
        grantedAt: null,
        lastReminderSentAt: null,
      });
      expect(updateBuilder.update).toHaveBeenCalledWith(EmergencyAccessContact);
      const setArgs = updateBuilder.set.mock.calls[0][0];
      expect(setArgs.claimTokenUsedAt()).toBe("CURRENT_TIMESTAMP");
      expect(setArgs.claimVoidedReason).toBe("owner_revoked");
      expect(view.grantedAt).toBeNull();
    });

    it("clears the grant marker and voids the links in one transaction", async () => {
      // Split across two, a failure on the voiding leaves `granted_at` already
      // NULL and committed: the page reports the grant cleared, the button says it
      // worked, and every delivered magic link stays claimable for the rest of its
      // 30 days. That is the one ordering this method must not have.
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      settingsRepo.findOne.mockResolvedValue(stored);
      settingsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      contactsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error("voiding failed")),
      });

      await expect(service.resetGrantedState(userId)).rejects.toThrow(
        "voiding failed",
      );

      // One transaction opened, and it is the one that threw -- so the settings
      // write rolls back with it rather than standing as a committed lie.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });
});
