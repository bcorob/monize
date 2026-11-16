import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { FindOperator, In, Not } from "typeorm";
import { I18nService } from "nestjs-i18n";
import { DelegationService, DELEGATE_2FA_REQUIRED } from "./delegation.service";
import { DelegateAccountFavourite } from "./entities/delegate-account-favourite.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { OAUTH_GRANT_REVOKER } from "../auth/credential-revocation";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("DelegationService", () => {
  // Real UUIDs, not "o1"/"d1": the delegation reads run under
  // `withDelegateContext`, which rejects a non-UUID id at the wrap site rather
  // than letting it reach a policied statement as a 22P02.
  const OWNER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const DELEGATE_ID = "d1a2b3c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const SELF_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
  const OTHER_OWNER_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

  let service: DelegationService;
  let delegatesRepo: Record<string, jest.Mock>;
  let grantsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let prefsRepo: Record<string, jest.Mock>;
  let refreshRepo: Record<string, jest.Mock>;
  let patRepo: Record<string, jest.Mock>;
  let trustedDevicesRepo: Record<string, jest.Mock>;
  let oauthProviderService: { revokeAllForUser: jest.Mock };
  let accountsRepo: Record<string, jest.Mock>;
  let transactionsRepo: Record<string, jest.Mock>;
  let scheduledTxRepo: Record<string, jest.Mock>;
  let scheduledOverrideRepo: Record<string, jest.Mock>;
  let delegateFavouritesRepo: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let scopedManager: Record<string, jest.Mock>;

  beforeEach(() => {
    delegatesRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      exists: jest.fn().mockResolvedValue(true),
    };
    grantsRepo = { findOne: jest.fn(), find: jest.fn(), count: jest.fn() };
    usersRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    prefsRepo = { findOne: jest.fn() };
    refreshRepo = { update: jest.fn() };
    patRepo = { update: jest.fn() };
    trustedDevicesRepo = { delete: jest.fn() };
    oauthProviderService = { revokeAllForUser: jest.fn().mockResolvedValue(0) };
    accountsRepo = { find: jest.fn(), exists: jest.fn(), count: jest.fn() };
    transactionsRepo = { findOne: jest.fn() };
    scheduledTxRepo = { findOne: jest.fn() };
    scheduledOverrideRepo = { find: jest.fn().mockResolvedValue([]) };
    delegateFavouritesRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
    };
    emailService = { getStatus: jest.fn(), sendMail: jest.fn() };
    configService = { get: jest.fn() };
    // Every read/write now runs through `withScopedDb`, which the harness maps
    // onto `dataSource.transaction`, with the per-entity repository mocks
    // routed through `manager.getRepository`.
    const scoped = createScopedDbMocks([
      [AccountDelegate, delegatesRepo as never],
      [AccountDelegateGrant, grantsRepo as never],
      [User, usersRepo as never],
      [UserPreference, prefsRepo as never],
      [RefreshToken, refreshRepo as never],
      [Account, accountsRepo as never],
      [Transaction, transactionsRepo as never],
      [ScheduledTransaction, scheduledTxRepo as never],
      [ScheduledTransactionOverride, scheduledOverrideRepo as never],
      [DelegateAccountFavourite, delegateFavouritesRepo as never],
      [PersonalAccessToken, patRepo as never],
      [TrustedDevice, trustedDevicesRepo as never],
    ]);
    // `repo.manager` is the transaction's manager, as on a real repository.
    (refreshRepo as Record<string, unknown>).manager = scoped.manager;
    scopedManager = scoped.manager as unknown as Record<string, jest.Mock>;
    scopedManager.query.mockResolvedValue([]);
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    const i18nStub = {
      translate: (key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? key,
    } as unknown as I18nService;

    service = new DelegationService(
      emailService as any,
      configService as any,
      dataSource as any,
      i18nStub,
      {
        get: jest.fn((token: unknown) =>
          token === OAUTH_GRANT_REVOKER ? oauthProviderService : undefined,
        ),
      } as any,
    );
  });

  /**
   * Install a `dataSource.transaction` stub for a spec that drives the
   * transaction body directly, giving the supplied manager a `getRepository`
   * routed at the same per-entity mocks so unrelated scoped reads inside the
   * same flow still resolve.
   */
  function installTransactionMock(manager: Record<string, any>) {
    manager.getRepository ??= jest.fn((entity: unknown) => {
      if (entity === AccountDelegate) return delegatesRepo;
      if (entity === AccountDelegateGrant) return grantsRepo;
      if (entity === User) return usersRepo;
      if (entity === UserPreference) return prefsRepo;
      if (entity === RefreshToken) return refreshRepo;
      if (entity === Account) return accountsRepo;
      if (entity === Transaction) return transactionsRepo;
      if (entity === ScheduledTransaction) return scheduledTxRepo;
      if (entity === ScheduledTransactionOverride) return scheduledOverrideRepo;
      if (entity === DelegateAccountFavourite) return delegateFavouritesRepo;
      throw new Error(`unregistered entity in transaction: ${String(entity)}`);
    });
    dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
    return manager;
  }

  describe("validateActingContext", () => {
    const args = {
      delegateUserId: DELEGATE_ID,
      actingAsUserId: OWNER_ID,
      delegationId: "g1",
    };

    it("rejects when the delegation is missing", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.validateActingContext(args)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects when the delegation is revoked", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "revoked",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
      });
      await expect(service.validateActingContext(args)).rejects.toThrow(
        "Delegated access is no longer valid",
      );
    });

    it("rejects when the delegate id does not match the token", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: "someone-else",
        ownerUserId: OWNER_ID,
      });
      await expect(service.validateActingContext(args)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects when the owner is inactive", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
      });
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, isActive: false });
      await expect(service.validateActingContext(args)).rejects.toThrow(
        "Delegated access is no longer valid",
      );
    });

    it("throws DELEGATE_2FA_REQUIRED when owner needs 2FA and delegate lacks it", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
      });
      // owner active (validateActingContext call) then owner+pref for 2FA
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === OWNER_ID
          ? { id: OWNER_ID, isActive: true, twoFactorSecret: "secret" }
          : { id: DELEGATE_ID, twoFactorSecret: null },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === OWNER_ID
          ? { userId: OWNER_ID, twoFactorEnabled: true }
          : { userId: DELEGATE_ID, twoFactorEnabled: false },
      );

      await expect(service.validateActingContext(args)).rejects.toThrow(
        DELEGATE_2FA_REQUIRED,
      );
    });

    it("returns the delegation when everything checks out", async () => {
      const delegation = {
        id: "g1",
        status: "active",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      usersRepo.findOne.mockResolvedValue({
        id: OWNER_ID,
        isActive: true,
        twoFactorSecret: null,
      });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      await expect(service.validateActingContext(args)).resolves.toBe(
        delegation,
      );
    });
  });

  describe("accountIdForTransaction", () => {
    it("returns the transaction's account id", async () => {
      transactionsRepo.findOne.mockResolvedValue({ accountId: "a1" });
      await expect(service.accountIdForTransaction("t1")).resolves.toBe("a1");
    });

    it("returns null when the transaction does not exist", async () => {
      transactionsRepo.findOne.mockResolvedValue(null);
      await expect(service.accountIdForTransaction("t1")).resolves.toBeNull();
    });
  });

  describe("accountIdsForTransfer", () => {
    it("returns both legs' accounts", async () => {
      transactionsRepo.findOne
        .mockResolvedValueOnce({ accountId: "a1", linkedTransactionId: "t2" })
        .mockResolvedValueOnce({ accountId: "a2" });
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
    });

    it("returns just the one account when there is no linked leg", async () => {
      transactionsRepo.findOne.mockResolvedValueOnce({
        accountId: "a1",
        linkedTransactionId: null,
      });
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([
        "a1",
      ]);
    });

    it("returns [] when the transaction does not exist", async () => {
      transactionsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([]);
    });
  });

  describe("accountIdsForScheduled", () => {
    it("returns [] when the scheduled row does not exist", async () => {
      scheduledTxRepo.findOne.mockResolvedValue(null);
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([]);
    });

    it("returns just the account for a non-transfer", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: false,
        transferAccountId: null,
      });
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
      ]);
    });

    it("returns both accounts for a transfer", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: true,
        transferAccountId: "a2",
      });
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
    });

    it("ignores a stale transferAccountId on a non-transfer", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: false,
        transferAccountId: "a2",
      });
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
      ]);
    });

    // A delegate write on a schedule posts into every account it names; gating
    // only the primary account let a delegate post an owner-created split or
    // funded schedule through an account they were never granted.
    it("includes the funding, split and override-split transfer accounts", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: false,
        transferAccountId: null,
        investmentFundingAccountId: "fund",
        splits: [
          { transferAccountId: "split-b" },
          { transferAccountId: null },
          { transferAccountId: "a1" },
        ],
      });
      scheduledOverrideRepo.find.mockResolvedValue([
        { splits: [{ transferAccountId: "ovr-c" }, { categoryId: "cat" }] },
        { splits: null },
      ]);
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
        "fund",
        "split-b",
        "ovr-c",
      ]);
      expect(scheduledOverrideRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scheduledTransactionId: "s1" },
        }),
      );
    });
  });

  describe("hasReadAccess", () => {
    it("is true only when a can_read grant exists", async () => {
      grantsRepo.findOne.mockResolvedValue({ id: "x" });
      await expect(service.hasReadAccess("g1", "a1")).resolves.toBe(true);
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(service.hasReadAccess("g1", "a1")).resolves.toBe(false);
    });
  });

  describe("resolveSwitchTarget", () => {
    it("returns null for the delegate's own id (self)", async () => {
      await expect(
        service.resolveSwitchTarget(DELEGATE_ID, DELEGATE_ID),
      ).resolves.toBeNull();
    });

    it("throws when there is no active delegation for the target", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resolveSwitchTarget(DELEGATE_ID, OWNER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("setGrants", () => {
    it("rejects accounts that do not belong to the owner", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
      });
      accountsRepo.find.mockResolvedValue([{ id: "a1" }]); // only 1 of 2 owned
      await expect(
        service.setGrants(OWNER_ID, "g1", [
          { accountId: "a1", canRead: true },
          { accountId: "a2", canRead: true },
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws when the delegation is not owned by the caller", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.setGrants(OWNER_ID, "g1", []),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects CREATE/EDIT/DELETE without READ", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
      });
      await expect(
        service.setGrants(OWNER_ID, "g1", [
          { accountId: "a1", canRead: false, canCreate: true },
        ]),
      ).rejects.toThrow(/READ access is required/);
    });

    it("persists per-account CRUD flags for readable accounts", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
      });
      accountsRepo.find.mockResolvedValue([{ id: "a1" }]);
      const saved: any[] = [];
      const manager = {
        delete: jest.fn(),
        create: jest.fn((_e, v) => v),
        save: jest.fn((rows) => saved.push(...rows)),
      };
      installTransactionMock(manager);

      await service.setGrants(OWNER_ID, "g1", [
        {
          accountId: "a1",
          canRead: true,
          canCreate: true,
          canEdit: false,
          canDelete: true,
        },
        // canRead=false -> dropped entirely (no access)
        { accountId: "a2", canRead: false },
      ]);

      expect(manager.delete).toHaveBeenCalled();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({
        delegationId: "g1",
        accountId: "a1",
        canRead: true,
        canCreate: true,
        canEdit: false,
        canDelete: true,
        isJoint: false,
      });
    });

    it("rejects a joint flag without READ", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
      });
      await expect(
        service.setGrants(OWNER_ID, "g1", [
          { accountId: "a1", canRead: false, isJoint: true },
        ]),
      ).rejects.toThrow(/READ access is required to mark an account as joint/);
    });

    it("rejects a joint flag for a delegate who is not a full account", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      // isFullAccount(d1): no accounts, no delegations of their own, not admin.
      accountsRepo.count = jest.fn().mockResolvedValue(0);
      delegatesRepo.count = jest.fn().mockResolvedValue(0);
      usersRepo.findOne.mockResolvedValue({ id: DELEGATE_ID, role: "user" });

      await expect(
        service.setGrants(OWNER_ID, "g1", [
          { accountId: "a1", canRead: true, isJoint: true },
        ]),
      ).rejects.toThrow(/their own Monize account/);
    });

    it("persists isJoint for a full-account delegate", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      accountsRepo.count = jest.fn().mockResolvedValue(2); // owns accounts
      delegatesRepo.count = jest.fn().mockResolvedValue(0);
      usersRepo.findOne.mockResolvedValue({ id: DELEGATE_ID, role: "user" });
      accountsRepo.find.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
      const saved: any[] = [];
      const manager = {
        delete: jest.fn(),
        create: jest.fn((_e, v) => v),
        save: jest.fn((rows) => saved.push(...rows)),
      };
      installTransactionMock(manager);

      await service.setGrants(OWNER_ID, "g1", [
        { accountId: "a1", canRead: true, canCreate: true, isJoint: true },
        { accountId: "a2", canRead: true },
      ]);

      expect(saved.map((r) => [r.accountId, r.isJoint])).toEqual([
        ["a1", true],
        ["a2", false],
      ]);
    });
  });

  describe("hasAccountPermission", () => {
    it("is false when there is no readable grant", async () => {
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.hasAccountPermission("g1", "a1", "read"),
      ).resolves.toBe(false);
    });

    it("maps each operation to the matching flag", async () => {
      grantsRepo.findOne.mockResolvedValue({
        canRead: true,
        canCreate: true,
        canEdit: false,
        canDelete: true,
      });
      await expect(
        service.hasAccountPermission("g1", "a1", "read"),
      ).resolves.toBe(true);
      await expect(
        service.hasAccountPermission("g1", "a1", "create"),
      ).resolves.toBe(true);
      await expect(
        service.hasAccountPermission("g1", "a1", "edit"),
      ).resolves.toBe(false);
      await expect(
        service.hasAccountPermission("g1", "a1", "delete"),
      ).resolves.toBe(true);
    });
  });

  describe("delegateMustEnrollOwn2FA", () => {
    it("is false when the owner does not require 2FA", async () => {
      usersRepo.findOne.mockResolvedValue({
        id: OWNER_ID,
        twoFactorSecret: null,
      });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      await expect(
        service.delegateMustEnrollOwn2FA(OWNER_ID, DELEGATE_ID),
      ).resolves.toBe(false);
    });

    it("is false when the delegate already has their own 2FA", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === OWNER_ID
          ? { id: OWNER_ID, twoFactorSecret: "s" }
          : { id: DELEGATE_ID, twoFactorSecret: "d" },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === OWNER_ID
          ? { twoFactorEnabled: true }
          : { twoFactorEnabled: true },
      );
      await expect(
        service.delegateMustEnrollOwn2FA(OWNER_ID, DELEGATE_ID),
      ).resolves.toBe(false);
    });
  });

  describe("resolveSwitchTarget", () => {
    it("throws DELEGATE_2FA_REQUIRED when the target owner requires 2FA", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
        status: "active",
      });
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === OWNER_ID
          ? { id: OWNER_ID, twoFactorSecret: "s" }
          : { id: DELEGATE_ID, twoFactorSecret: null },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === OWNER_ID
          ? { twoFactorEnabled: true }
          : { twoFactorEnabled: false },
      );
      await expect(
        service.resolveSwitchTarget(DELEGATE_ID, OWNER_ID),
      ).rejects.toThrow(DELEGATE_2FA_REQUIRED);
    });

    it("returns the delegation when the switch is allowed", async () => {
      const delegation = {
        id: "g1",
        delegateUserId: DELEGATE_ID,
        ownerUserId: OWNER_ID,
        status: "active",
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      usersRepo.findOne.mockResolvedValue({
        id: OWNER_ID,
        twoFactorSecret: null,
      });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      await expect(
        service.resolveSwitchTarget(DELEGATE_ID, OWNER_ID),
      ).resolves.toBe(delegation);
    });
  });

  describe("getAvailableContexts", () => {
    beforeEach(() => {
      // No grants assigned unless a case says otherwise; the joint-only
      // filter reads them for every delegation.
      grantsRepo.find.mockResolvedValue([]);
    });

    it("returns [] when the user does not exist", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.getAvailableContexts(SELF_ID)).resolves.toEqual([]);
    });

    it("returns [] for a user with no delegations", async () => {
      usersRepo.findOne.mockResolvedValue({ id: SELF_ID });
      delegatesRepo.find.mockResolvedValue([]);
      await expect(service.getAvailableContexts(SELF_ID)).resolves.toEqual([]);
    });

    it("includes a self context when the user owns data", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === SELF_ID
          ? {
              id: SELF_ID,
              firstName: "Del",
              lastName: "Egate",
              isDelegateOnly: false,
            }
          : {
              id: OWNER_ID,
              firstName: "Own",
              lastName: "Er",
              twoFactorSecret: null,
            },
      );
      delegatesRepo.find.mockResolvedValue([
        {
          ownerUserId: OWNER_ID,
          owner: { id: OWNER_ID, firstName: "Own", lastName: "Er" },
        },
      ]);
      accountsRepo.exists.mockResolvedValue(true);
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      const res = await service.getAvailableContexts(SELF_ID);
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual(
        expect.objectContaining({ userId: SELF_ID, isSelf: true }),
      );
      expect(res[1]).toEqual(
        expect.objectContaining({ userId: OWNER_ID, isSelf: false }),
      );
    });

    it("includes a self context for a self-registered user even when they own no data yet", async () => {
      // Covers the claim-path bug: a user who upgraded out of a pure
      // delegate row via /register has no accounts yet, but must still
      // see a "self" context so the banner appears and they don't get
      // auto-switched into the owner's account.
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === SELF_ID
          ? { id: SELF_ID, firstName: "Self", isDelegateOnly: false }
          : { id: OWNER_ID, twoFactorSecret: null },
      );
      delegatesRepo.find.mockResolvedValue([
        { ownerUserId: OWNER_ID, owner: null },
      ]);
      accountsRepo.exists.mockResolvedValue(false);
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      const res = await service.getAvailableContexts(SELF_ID);
      expect(res).toHaveLength(2);
      expect(res.find((c) => c.isSelf)).toEqual(
        expect.objectContaining({ userId: SELF_ID, isSelf: true }),
      );
    });

    it("omits the self context for an owner-managed pure delegate with no data", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === SELF_ID
          ? { id: SELF_ID, isDelegateOnly: true }
          : { id: OWNER_ID, twoFactorSecret: null },
      );
      delegatesRepo.find.mockResolvedValue([
        { ownerUserId: OWNER_ID, owner: null },
      ]);
      accountsRepo.exists.mockResolvedValue(false);
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      const res = await service.getAvailableContexts(SELF_ID);
      expect(res).toHaveLength(1);
      expect(res[0].isSelf).toBe(false);
      expect(res[0].label).toBe(OWNER_ID);
    });

    describe("joint-only delegations", () => {
      /** A full-account grantee with one active delegation from OWNER_ID. */
      function arrangeGrantee(delegation: Record<string, unknown> = {}) {
        usersRepo.findOne.mockImplementation(({ where }: any) =>
          where.id === SELF_ID
            ? { id: SELF_ID, firstName: "Del", isDelegateOnly: false }
            : { id: OWNER_ID, firstName: "Own", twoFactorSecret: null },
        );
        delegatesRepo.find.mockResolvedValue([
          {
            id: "g1",
            ownerUserId: OWNER_ID,
            owner: { id: OWNER_ID, firstName: "Own" },
            ...delegation,
          },
        ]);
        accountsRepo.exists.mockResolvedValue(true);
        prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      }

      it("drops the owner context when every readable grant is joint", async () => {
        arrangeGrantee();
        grantsRepo.find.mockResolvedValue([
          { delegationId: "g1", accountId: "a1", canRead: true, isJoint: true },
          { delegationId: "g1", accountId: "a2", canRead: true, isJoint: true },
        ]);

        // Nothing to switch between: both accounts are already native.
        await expect(service.getAvailableContexts(SELF_ID)).resolves.toEqual(
          [],
        );
      });

      it("keeps the owner context when a readable grant is not joint", async () => {
        arrangeGrantee();
        grantsRepo.find.mockResolvedValue([
          { delegationId: "g1", accountId: "a1", canRead: true, isJoint: true },
          {
            delegationId: "g1",
            accountId: "a2",
            canRead: true,
            isJoint: false,
          },
        ]);

        const res = await service.getAvailableContexts(SELF_ID);
        expect(res.map((c) => c.userId)).toEqual([SELF_ID, OWNER_ID]);
      });

      it.each([
        ["billsCanRead"],
        ["investmentsCanRead"],
        ["budgetsCanRead"],
        ["reportsCanRead"],
        ["aiCanRead"],
        ["warrantiesCanRead"],
      ])("keeps the owner context when %s is granted", async (field) => {
        arrangeGrantee({ [field]: true });
        grantsRepo.find.mockResolvedValue([
          { delegationId: "g1", accountId: "a1", canRead: true, isJoint: true },
        ]);

        const res = await service.getAvailableContexts(SELF_ID);
        expect(res.map((c) => c.userId)).toEqual([SELF_ID, OWNER_ID]);
      });

      it.each([
        ["payeesCanCreate"],
        ["payeesCanEdit"],
        ["payeesCanDelete"],
        ["categoriesCanCreate"],
        ["categoriesCanEdit"],
        ["categoriesCanDelete"],
        ["tagsCanCreate"],
        ["tagsCanEdit"],
        ["tagsCanDelete"],
      ])(
        "keeps the owner context when the %s capability is granted",
        async (field) => {
          arrangeGrantee({ [field]: true });
          grantsRepo.find.mockResolvedValue([
            {
              delegationId: "g1",
              accountId: "a1",
              canRead: true,
              isJoint: true,
            },
          ]);

          const res = await service.getAvailableContexts(SELF_ID);
          expect(res.map((c) => c.userId)).toEqual([SELF_ID, OWNER_ID]);
        },
      );

      it("keeps a delegation whose grants are not assigned yet", async () => {
        // No joint share stands in for the context, so hiding it would leave
        // the delegate unable to switch in once the owner grants something.
        arrangeGrantee();
        grantsRepo.find.mockResolvedValue([]);

        const res = await service.getAvailableContexts(SELF_ID);
        expect(res.map((c) => c.userId)).toEqual([SELF_ID, OWNER_ID]);
      });

      it("keeps a joint-only owner the caller is currently acting as", async () => {
        // Hiding the context the user is standing in would strip the only
        // control that gets them back to their own account.
        arrangeGrantee();
        grantsRepo.find.mockResolvedValue([
          { delegationId: "g1", accountId: "a1", canRead: true, isJoint: true },
        ]);

        const res = await service.getAvailableContexts(SELF_ID, OWNER_ID);
        expect(res.map((c) => c.userId)).toEqual([SELF_ID, OWNER_ID]);
      });

      it("drops only the joint-only owner, keeping the other owner's context", async () => {
        usersRepo.findOne.mockImplementation(({ where }: any) =>
          where.id === SELF_ID
            ? { id: SELF_ID, firstName: "Del", isDelegateOnly: false }
            : { id: where.id, firstName: where.id, twoFactorSecret: null },
        );
        delegatesRepo.find.mockResolvedValue([
          {
            id: "g1",
            ownerUserId: OWNER_ID,
            owner: { id: OWNER_ID, firstName: "O1" },
          },
          {
            id: "g2",
            ownerUserId: OTHER_OWNER_ID,
            owner: { id: OTHER_OWNER_ID, firstName: "O2" },
          },
        ]);
        accountsRepo.exists.mockResolvedValue(true);
        prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
        grantsRepo.find.mockResolvedValue([
          { delegationId: "g1", accountId: "a1", canRead: true, isJoint: true },
          {
            delegationId: "g2",
            accountId: "a2",
            canRead: true,
            isJoint: false,
          },
        ]);

        const res = await service.getAvailableContexts(SELF_ID);
        expect(res.map((c) => c.userId)).toEqual([SELF_ID, OTHER_OWNER_ID]);
      });
    });
  });

  describe("listDelegates", () => {
    // The delegate's users row is no longer a relation on the delegation: it
    // is loaded by id under a system context, because users_self hides it from
    // the owner's own session. A spec that still fed it through `delegate:`
    // would assert against a join the service no longer performs.
    const delegateUserRow = {
      id: DELEGATE_ID,
      email: "d@e.f",
      firstName: "D",
      lastName: null,
      passwordHash: "h",
    };

    it("maps delegations to a safe summary", async () => {
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        role: "user",
        isDelegateOnly: true,
      });
      usersRepo.find.mockResolvedValue([delegateUserRow]);
      delegatesRepo.find.mockResolvedValue([
        {
          id: "g1",
          status: "active",
          createdAt: new Date("2026-01-01"),
          delegateUserId: DELEGATE_ID,
          payeesCanCreate: true,
          payeesCanEdit: true,
          payeesCanDelete: false,
          categoriesCanCreate: false,
          categoriesCanEdit: false,
          categoriesCanDelete: false,
          tagsCanCreate: true,
          tagsCanEdit: false,
          tagsCanDelete: false,
          grants: [
            {
              accountId: "a1",
              canRead: true,
              canCreate: true,
              canEdit: false,
              canDelete: false,
            },
            { accountId: "a2", canRead: false },
          ],
        },
      ]);
      const res = await service.listDelegates(OWNER_ID);
      expect(res[0]).toEqual({
        id: "g1",
        status: "active",
        createdAt: new Date("2026-01-01"),
        delegate: {
          id: DELEGATE_ID,
          email: "d@e.f",
          firstName: "D",
          lastName: null,
          hasPassword: true,
          canResetPassword: true,
          isFullAccount: false,
        },
        grants: [
          {
            accountId: "a1",
            canRead: true,
            canCreate: true,
            canEdit: false,
            canDelete: false,
          },
        ],
        capabilities: {
          payees: { create: true, edit: true, delete: false },
          categories: { create: false, edit: false, delete: false },
          tags: { create: true, edit: false, delete: false },
        },
        sections: {
          bills: false,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
          warranties: false,
        },
      });
    });

    it("includes granted sections in the summary", async () => {
      usersRepo.find.mockResolvedValue([delegateUserRow]);
      delegatesRepo.find.mockResolvedValue([
        {
          id: "g1",
          status: "active",
          createdAt: new Date("2026-01-01"),
          delegateUserId: DELEGATE_ID,
          billsCanRead: true,
          reportsCanRead: true,
          grants: [],
        },
      ]);
      const res = await service.listDelegates(OWNER_ID);
      expect(res[0].sections).toEqual({
        bills: true,
        investments: false,
        budgets: false,
        reports: true,
        ai: false,
        warranties: false,
      });
    });

    it("returns isJoint on every grant so a resave cannot silently clear it", async () => {
      // setGrants is delete-and-recreate: if this listing dropped isJoint,
      // the modal's next unchanged save would wipe every joint flag.
      usersRepo.find.mockResolvedValue([delegateUserRow]);
      delegatesRepo.find.mockResolvedValue([
        {
          id: "g1",
          status: "active",
          createdAt: new Date("2026-01-01"),
          delegateUserId: DELEGATE_ID,
          grants: [
            { accountId: "a1", canRead: true, isJoint: true },
            { accountId: "a2", canRead: true, isJoint: false },
          ],
        },
      ]);
      const res = await service.listDelegates(OWNER_ID);
      expect(res[0].grants.map((g) => g.isJoint)).toEqual([true, false]);
    });
  });

  describe("hasCapability", () => {
    it("is false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.hasCapability("g1", "payees", "create"),
      ).resolves.toBe(false);
    });

    it("maps resource+operation to the matching flag", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        payeesCanCreate: true,
        payeesCanEdit: false,
        payeesCanDelete: false,
        categoriesCanEdit: true,
        tagsCanDelete: true,
      });
      await expect(
        service.hasCapability("g1", "payees", "create"),
      ).resolves.toBe(true);
      await expect(service.hasCapability("g1", "payees", "edit")).resolves.toBe(
        false,
      );
      await expect(
        service.hasCapability("g1", "categories", "edit"),
      ).resolves.toBe(true);
      await expect(service.hasCapability("g1", "tags", "delete")).resolves.toBe(
        true,
      );
    });
  });

  describe("getCapabilities", () => {
    it("returns the nested capability set for an active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        payeesCanCreate: true,
        payeesCanEdit: false,
        payeesCanDelete: true,
        categoriesCanCreate: false,
        categoriesCanEdit: true,
        categoriesCanDelete: false,
        tagsCanCreate: false,
        tagsCanEdit: false,
        tagsCanDelete: false,
      });
      await expect(service.getCapabilities("g1")).resolves.toEqual({
        payees: { create: true, edit: false, delete: true },
        categories: { create: false, edit: true, delete: false },
        tags: { create: false, edit: false, delete: false },
      });
    });

    it("returns all-false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.getCapabilities("g1")).resolves.toEqual({
        payees: { create: false, edit: false, delete: false },
        categories: { create: false, edit: false, delete: false },
        tags: { create: false, edit: false, delete: false },
      });
    });
  });

  describe("setCapabilities", () => {
    it("throws when the delegation is not owned by the caller (or was revoked)", async () => {
      delegatesRepo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.setCapabilities(OWNER_ID, "g1", { payeesCanCreate: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("updates only the provided flags, conditionally on the owner, never by save (A26-M05)", async () => {
      await service.setCapabilities(OWNER_ID, "g1", {
        payeesCanCreate: true,
        tagsCanDelete: true,
        payeesCanEdit: undefined,
      });

      expect(delegatesRepo.update).toHaveBeenCalledWith(
        { id: "g1", ownerUserId: OWNER_ID },
        { payeesCanCreate: true, tagsCanDelete: true },
      );
      // A save of a stale entity re-INSERTs a delegation a revoke deleted.
      expect(delegatesRepo.save).not.toHaveBeenCalled();
    });

    it("404s an empty patch on a delegation that does not exist", async () => {
      delegatesRepo.exists.mockResolvedValue(false);
      await expect(
        service.setCapabilities(OWNER_ID, "g1", {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(delegatesRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("hasSection", () => {
    it("is false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.hasSection("g1", "bills")).resolves.toBe(false);
    });

    it("maps the section to the matching flag", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        billsCanRead: true,
        investmentsCanRead: false,
        budgetsCanRead: true,
        warrantiesCanRead: true,
      });
      await expect(service.hasSection("g1", "bills")).resolves.toBe(true);
      await expect(service.hasSection("g1", "investments")).resolves.toBe(
        false,
      );
      await expect(service.hasSection("g1", "budgets")).resolves.toBe(true);
      await expect(service.hasSection("g1", "ai")).resolves.toBe(false);
      await expect(service.hasSection("g1", "warranties")).resolves.toBe(true);
    });
  });

  describe("grantsWholeLedger", () => {
    const allSections = {
      ownerUserId: "owner-1",
      billsCanRead: true,
      investmentsCanRead: true,
      budgetsCanRead: true,
      reportsCanRead: true,
      aiCanRead: true,
      warrantiesCanRead: true,
    };

    it("is false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(false);
    });

    it("is false while the warranties section is withheld: the assistant's tools read warranties too", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        ...allSections,
        warrantiesCanRead: false,
      });
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(false);
      expect(accountsRepo.count).not.toHaveBeenCalled();
    });

    it("is false when any section is withheld, without counting accounts", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        ...allSections,
        budgetsCanRead: false,
      });
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(false);
      expect(accountsRepo.count).not.toHaveBeenCalled();
    });

    it("is false while any owner account is not READ-granted", async () => {
      delegatesRepo.findOne.mockResolvedValue(allSections);
      grantsRepo.find.mockResolvedValue([{ accountId: "a1" }]);
      accountsRepo.count.mockResolvedValue(1);
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(false);
      expect(accountsRepo.count).toHaveBeenCalledWith({
        where: { userId: "owner-1", id: Not(In(["a1"])) },
      });
    });

    it("counts every owner account as ungranted when nothing is granted", async () => {
      delegatesRepo.findOne.mockResolvedValue(allSections);
      grantsRepo.find.mockResolvedValue([]);
      accountsRepo.count.mockResolvedValue(2);
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(false);
      expect(accountsRepo.count).toHaveBeenCalledWith({
        where: { userId: "owner-1" },
      });
    });

    it("is true when every section and every owner account is granted", async () => {
      delegatesRepo.findOne.mockResolvedValue(allSections);
      grantsRepo.find.mockResolvedValue([
        { accountId: "a1" },
        { accountId: "a2" },
      ]);
      accountsRepo.count.mockResolvedValue(0);
      await expect(service.grantsWholeLedger("g1")).resolves.toBe(true);
    });
  });

  describe("getSections", () => {
    it("returns the section set for an active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        billsCanRead: true,
        investmentsCanRead: false,
        budgetsCanRead: false,
        reportsCanRead: true,
        aiCanRead: true,
        warrantiesCanRead: true,
      });
      await expect(service.getSections("g1")).resolves.toEqual({
        bills: true,
        investments: false,
        budgets: false,
        reports: true,
        ai: true,
        warranties: true,
      });
    });

    it("returns all-false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.getSections("g1")).resolves.toEqual({
        bills: false,
        investments: false,
        budgets: false,
        reports: false,
        ai: false,
        warranties: false,
      });
    });
  });

  describe("setSectionGrants", () => {
    it("throws when the delegation is not owned by the caller (or was revoked)", async () => {
      delegatesRepo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.setSectionGrants(OWNER_ID, "g1", { billsCanRead: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("updates only the provided sections, conditionally on the owner (A26-M05)", async () => {
      await service.setSectionGrants(OWNER_ID, "g1", {
        billsCanRead: true,
        reportsCanRead: true,
      });

      expect(delegatesRepo.update).toHaveBeenCalledWith(
        { id: "g1", ownerUserId: OWNER_ID },
        { billsCanRead: true, reportsCanRead: true },
      );
      expect(delegatesRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("revokeDelegate", () => {
    it("throws when the delegation is not found", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.revokeDelegate(OWNER_ID, "g1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    function managerFor(counts: {
      otherDelegations: number;
      ownsAccounts: number;
      ownsDelegations: number;
      role?: string;
      isDelegateOnly?: boolean;
    }) {
      const manager: any = {
        delete: jest.fn(),
        count: jest
          .fn()
          .mockResolvedValueOnce(counts.otherDelegations)
          .mockResolvedValueOnce(counts.ownsAccounts)
          .mockResolvedValueOnce(counts.ownsDelegations),
        findOne: jest.fn().mockResolvedValue({
          id: DELEGATE_ID,
          role: counts.role ?? "user",
          isDelegateOnly: counts.isDelegateOnly ?? true,
        }),
      };
      return manager;
    }

    it("fully deletes a pure delegate with no other ties", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 0,
        ownsDelegations: 0,
        isDelegateOnly: true,
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "g1",
      });
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: DELEGATE_ID,
      });
    });

    it("keeps a self-registered / claimed user even with no accounts of their own", async () => {
      // A user that has gone through /register (either as a fresh
      // sign-up or by claiming a delegate row) is a full account, even
      // if they haven't created any accounts yet. Revoking the
      // delegation must not delete their login.
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 0,
        ownsDelegations: 0,
        isDelegateOnly: false,
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "g1",
      });
    });

    it("keeps the user when they delegate for someone else", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 1,
        ownsAccounts: 0,
        ownsDelegations: 0,
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1); // delegation only
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "g1",
      });
    });

    it("keeps a pure delegate (isDelegateOnly=true) when they still delegate for another owner", async () => {
      // The isDelegateOnly check is an additional guard, not a
      // replacement: an owner-managed identity that still has at least
      // one OTHER active delegation must keep their login so the other
      // owner's Shared Access continues to work.
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 1,
        ownsAccounts: 0,
        ownsDelegations: 0,
        isDelegateOnly: true,
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1); // delegation only
    });

    it("keeps the user when they own data of their own", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 3,
        ownsDelegations: 0,
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1);
    });

    it("keeps an admin delegate", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: OWNER_ID,
        delegateUserId: DELEGATE_ID,
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 0,
        ownsDelegations: 0,
        role: "admin",
      });
      installTransactionMock(manager);

      await service.revokeDelegate(OWNER_ID, "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("isDelegateUser", () => {
    it("is true when the user has at least one delegation", async () => {
      delegatesRepo.count = jest.fn().mockResolvedValue(2);
      await expect(service.isDelegateUser(DELEGATE_ID)).resolves.toBe(true);
    });

    it("is false when the user has no delegations", async () => {
      delegatesRepo.count = jest.fn().mockResolvedValue(0);
      await expect(service.isDelegateUser(DELEGATE_ID)).resolves.toBe(false);
    });
  });

  describe("resetDelegatePassword", () => {
    it("throws when the delegation is not found", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resetDelegatePassword(OWNER_ID, "g1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an SSO delegate", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        oidcSubject: "sso",
      });
      await expect(
        service.resetDelegatePassword(OWNER_ID, "g1"),
      ).rejects.toThrow(/SSO/);
    });

    it("sets a temporary password and revokes sessions", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      const delegate = {
        id: DELEGATE_ID,
        oidcSubject: null,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60000),
        isDelegateOnly: true,
      };
      usersRepo.findOne.mockResolvedValue(delegate);
      usersRepo.save.mockResolvedValue(delegate);
      // One live family left after the commit, so the converging revoke runs a
      // pass under its lock and stops when the next pass changes nothing.
      scopedManager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("SELECT DISTINCT family_id")
            ? [{ family_id: "fam-1" }]
            : [],
        ),
      );
      refreshRepo.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValue({ affected: 0 });
      const res = await service.resetDelegatePassword(OWNER_ID, "g1");
      expect(res.temporaryPassword).toBeTruthy();
      expect((delegate as any).mustChangePassword).toBe(true);
      // Owner reset must clear any lockout so the delegate can sign in.
      expect((delegate as any).failedLoginAttempts).toBe(0);
      expect((delegate as any).lockedUntil).toBeNull();
      expect(refreshRepo.update).toHaveBeenCalledWith(
        { userId: DELEGATE_ID, isRevoked: false },
        { isRevoked: true },
      );
      // After the commit: the captured family, re-revoked under its lock, so a
      // successor a concurrent rotation inserted is covered (A26-M02).
      expect(refreshRepo.update).toHaveBeenCalledWith(
        { userId: DELEGATE_ID, familyId: In(["fam-1"]), isRevoked: false },
        { isRevoked: true },
      );
      expect(refreshRepo.update).toHaveBeenCalledTimes(3);
    });

    it("revokes the delegate's PATs, trusted devices and OAuth grants", async () => {
      // An owner reset cut the delegate's web sessions only; any other
      // credential issued on the old password kept working.
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      const delegate = {
        id: DELEGATE_ID,
        oidcSubject: null,
        isDelegateOnly: true,
      };
      usersRepo.findOne.mockResolvedValue(delegate);
      usersRepo.save.mockResolvedValue(delegate);

      await service.resetDelegatePassword(OWNER_ID, "g1");

      expect(patRepo.update).toHaveBeenCalledWith(
        { userId: DELEGATE_ID, isRevoked: false },
        { isRevoked: true },
      );
      expect(trustedDevicesRepo.delete).toHaveBeenCalledWith({
        userId: DELEGATE_ID,
      });
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        DELEGATE_ID,
      );
    });

    it("refuses when the delegate is a full account (owns accounts)", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        oidcSubject: null,
      });
      accountsRepo.count.mockResolvedValue(2); // owns their own accounts
      await expect(
        service.resetDelegatePassword(OWNER_ID, "g1"),
      ).rejects.toThrow(ForbiddenException);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("refuses when the delegate is a delegate for another owner too", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        oidcSubject: null,
      });
      accountsRepo.count.mockResolvedValue(0);
      // isFullAccount's ownerUserId count = 0; delegateUserId count = 2.
      delegatesRepo.count = jest
        .fn()
        .mockResolvedValueOnce(0) // ownsDelegations (isFullAccount)
        .mockResolvedValueOnce(2); // delegations as delegate
      await expect(
        service.resetDelegatePassword(OWNER_ID, "g1"),
      ).rejects.toThrow(ForbiddenException);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("canOwnerResetDelegatePassword", () => {
    it("is true for an owner-provisioned pure delegate", async () => {
      accountsRepo.count.mockResolvedValue(0);
      delegatesRepo.count = jest.fn().mockResolvedValue(0);
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        role: "user",
        isDelegateOnly: true,
      });
      await expect(
        service.canOwnerResetDelegatePassword(DELEGATE_ID),
      ).resolves.toBe(true);
    });

    it("is false when the delegate is also a delegate elsewhere", async () => {
      accountsRepo.count.mockResolvedValue(0);
      delegatesRepo.count = jest
        .fn()
        .mockResolvedValueOnce(0) // ownsDelegations (isFullAccount)
        .mockResolvedValueOnce(2); // delegations as delegate
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        role: "user",
        isDelegateOnly: true,
      });
      await expect(
        service.canOwnerResetDelegatePassword(DELEGATE_ID),
      ).resolves.toBe(false);
    });

    it("is false for a claimed / self-registered user even with no own data yet", async () => {
      // A user who went through /register (either as a fresh signup or
      // via the claim path) has isDelegateOnly=false from that moment
      // on; their login is theirs, so the owner can't rotate it even
      // before they have created any accounts of their own.
      usersRepo.findOne.mockResolvedValue({
        id: DELEGATE_ID,
        role: "user",
        isDelegateOnly: false,
      });
      await expect(
        service.canOwnerResetDelegatePassword(DELEGATE_ID),
      ).resolves.toBe(false);
    });

    it("is false when the user record cannot be found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.canOwnerResetDelegatePassword(DELEGATE_ID),
      ).resolves.toBe(false);
    });
  });

  describe("delegateEmailExists", () => {
    it("is true when a user with the (normalized) email exists", async () => {
      usersRepo.findOne.mockResolvedValue({ id: SELF_ID });
      await expect(service.delegateEmailExists("  Foo@Bar.Com ")).resolves.toBe(
        true,
      );
      expect(usersRepo.findOne).toHaveBeenCalledWith({
        where: { email: "foo@bar.com" },
        select: ["id"],
      });
    });

    it("is false when no user has that email", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.delegateEmailExists("x@y.z")).resolves.toBe(false);
    });
  });

  describe("createDelegate", () => {
    const makeManager = () => {
      const manager: any = {
        findOne: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((_e: any, v: any) => v),
        save: jest.fn((v: any) => ({ id: "g-new", ...v })),
      };
      return manager;
    };

    // `manager.count` over a fixed set of delegation rows, honouring the
    // `delegateUserId` / `ownerUserId` equality and `Not(...)` filters the
    // service passes. Accounts are always 0 (no data of their own).
    const countDelegationsOf =
      (rows: Array<{ ownerUserId: string; delegateUserId: string }>) =>
      (entity: unknown, opts: { where?: Record<string, unknown> }) => {
        if (entity !== AccountDelegate) return Promise.resolve(0);
        const where = opts?.where ?? {};
        const matches = (value: string, filter: unknown) => {
          if (filter === undefined) return true;
          if (filter instanceof FindOperator && filter.type === "not")
            return value !== filter.value;
          return value === filter;
        };
        return Promise.resolve(
          rows.filter(
            (r) =>
              matches(r.ownerUserId, where.ownerUserId) &&
              matches(r.delegateUserId, where.delegateUserId),
          ).length,
        );
      };

    it("throws when the owner is not found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createDelegate(OWNER_ID, { email: "a@b.c" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects delegating to your own email", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "me@x.y" });
      await expect(
        service.createDelegate(OWNER_ID, { email: "ME@x.y" } as any),
      ).rejects.toThrow(/yourself/);
    });

    it("auto-generates a temporary password for a brand-new delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null); // no existing user, no delegation
      installTransactionMock(manager);
      const res = await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
      } as any);
      expect(res.temporaryPassword).toBeTruthy();
      expect(res.invited).toBe(false);
    });

    it("clears lockout when the owner sets a password for a locked pure-delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const lockedUser = {
        id: DELEGATE_ID,
        email: "new@x.y",
        oidcSubject: null,
        role: "user",
        passwordHash: "old-hash",
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60000),
      };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(lockedUser) // User by email
        .mockResolvedValueOnce({ id: "g1", status: "pending" }); // own delegation
      // A pure delegate row of THIS owner only (owns no data, its one
      // delegation is the caller's), so credential management is allowed --
      // a fresh self-registered user with no delegate role would not be.
      manager.count.mockImplementation(
        countDelegationsOf([
          { ownerUserId: OWNER_ID, delegateUserId: DELEGATE_ID },
        ]),
      );
      installTransactionMock(manager);
      await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
        password: "StrongPass1!xyz",
      } as any);
      expect(lockedUser.failedLoginAttempts).toBe(0);
      expect(lockedUser.lockedUntil).toBeNull();
      expect(lockedUser.passwordHash).not.toBe("old-hash");
    });

    describe("an existing delegate row of another owner (account takeover)", () => {
      // The row exists solely as OTHER_OWNER_ID's delegate. Were the caller
      // allowed to set its password, mint an invite token or clear its
      // lockout, they could sign in as that delegate and switch into
      // OTHER_OWNER_ID's data. Only the delegation may be linked.
      const makeForeignDelegate = () => ({
        id: DELEGATE_ID,
        email: "shared@x.y",
        oidcSubject: null,
        role: "user",
        isDelegateOnly: true,
        passwordHash: "OTHER-OWNER-SET" as string | null,
        mustChangePassword: false,
        resetToken: null as string | null,
        resetTokenExpiry: null as Date | null,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60000) as Date | null,
      });

      const arrange = (existing: ReturnType<typeof makeForeignDelegate>) => {
        usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
        const manager = makeManager();
        manager.findOne
          .mockResolvedValueOnce(existing) // User by email
          .mockResolvedValueOnce(null); // no delegation from the caller yet
        manager.count.mockImplementation(
          countDelegationsOf([
            { ownerUserId: OTHER_OWNER_ID, delegateUserId: DELEGATE_ID },
          ]),
        );
        installTransactionMock(manager);
        return manager;
      };

      const expectCredentialsUntouched = (
        existing: ReturnType<typeof makeForeignDelegate>,
      ) => {
        expect(existing.passwordHash).toBe("OTHER-OWNER-SET");
        expect(existing.resetToken).toBeNull();
        expect(existing.resetTokenExpiry).toBeNull();
        expect(existing.failedLoginAttempts).toBe(5);
        expect(existing.lockedUntil).not.toBeNull();
      };

      it("does not set an owner-supplied password", async () => {
        const existing = makeForeignDelegate();
        const manager = arrange(existing);

        const res = await service.createDelegate(OWNER_ID, {
          email: "shared@x.y",
          password: "StrongPass1!xyz",
        } as any);

        expectCredentialsUntouched(existing);
        expect(res.temporaryPassword).toBeUndefined();
        expect(res.invited).toBe(false);
        // The delegation itself is still linked.
        expect(manager.create).toHaveBeenCalledWith(
          AccountDelegate,
          expect.objectContaining({
            ownerUserId: OWNER_ID,
            delegateUserId: DELEGATE_ID,
          }),
        );
      });

      it("does not mint an invite token or send the invite", async () => {
        emailService.getStatus.mockReturnValue({ configured: true });
        emailService.sendMail.mockResolvedValue(undefined);
        configService.get.mockReturnValue("http://app");
        const existing = makeForeignDelegate();
        arrange(existing);

        const res = await service.createDelegate(OWNER_ID, {
          email: "shared@x.y",
          sendInvite: true,
        } as any);

        expectCredentialsUntouched(existing);
        expect(res.invited).toBe(false);
        expect(emailService.sendMail).not.toHaveBeenCalled();
      });

      it("does not issue a temporary password for a passwordless row", async () => {
        const existing = makeForeignDelegate();
        existing.passwordHash = null;
        arrange(existing);

        const res = await service.createDelegate(OWNER_ID, {
          email: "shared@x.y",
        } as any);

        expect(existing.passwordHash).toBeNull();
        expect(existing.failedLoginAttempts).toBe(5);
        expect(res.temporaryPassword).toBeUndefined();
      });
    });

    it("sends an invite when sendInvite is set and SMTP is configured", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: true });
      emailService.sendMail.mockResolvedValue(undefined);
      configService.get.mockReturnValue("http://app");
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      installTransactionMock(manager);
      const res = await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
        sendInvite: true,
      } as any);
      expect(res.invited).toBe(true);
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    it("resolves the invite email language from the delegate's stored preference", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: true });
      emailService.sendMail.mockResolvedValue(undefined);
      configService.get.mockReturnValue("http://app");
      prefsRepo.findOne.mockResolvedValue({ userId: "g-new", language: "fr" });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      installTransactionMock(manager);

      await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
        sendInvite: true,
      } as any);

      expect(prefsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: "g-new" },
      });
    });

    it("rejects an invite when SMTP is not configured", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: false });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      installTransactionMock(manager);
      await expect(
        service.createDelegate(OWNER_ID, {
          email: "new@x.y",
          sendInvite: true,
        } as any),
      ).rejects.toThrow(/SMTP/);
    });

    it("uses an owner-supplied password without forcing a change", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      installTransactionMock(manager);
      const res = await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
        password: "StrongPass1!xyz",
      } as any);
      expect(res.temporaryPassword).toBeUndefined();
      expect(res.invited).toBe(false);
    });

    it("reactivates a previously revoked delegation for an existing user", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const manager = makeManager();
      const existingDelegation = { id: "g1", status: "revoked" };
      manager.findOne
        .mockResolvedValueOnce({ id: DELEGATE_ID }) // existing user
        .mockResolvedValueOnce(existingDelegation); // existing delegation
      installTransactionMock(manager);
      await service.createDelegate(OWNER_ID, { email: "new@x.y" } as any);
      expect(existingDelegation.status).toBe("active");
    });

    it("conflicts when the user is already an active delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce({ id: DELEGATE_ID })
        .mockResolvedValueOnce({ id: "g1", status: "active" });
      installTransactionMock(manager);
      await expect(
        service.createDelegate(OWNER_ID, { email: "new@x.y" } as any),
      ).rejects.toThrow(/already a delegate/);
    });

    it("rejects when the existing user is the owner themselves", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValueOnce({ id: OWNER_ID });
      installTransactionMock(manager);
      await expect(
        service.createDelegate(OWNER_ID, { email: "new@x.y" } as any),
      ).rejects.toThrow(/yourself/);
    });

    it("sets a password on an existing passwordless pure-delegate (re-link)", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const existing = { id: DELEGATE_ID, passwordHash: null };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(existing) // existing user
        .mockResolvedValueOnce(null); // no delegation yet
      // count(Account)=0, count(AccountDelegate owner)=0 -> pure delegate
      installTransactionMock(manager);

      await service.createDelegate(OWNER_ID, {
        email: "shared@x.y",
        password: "StrongPass1!xyz",
      } as any);

      expect(existing.passwordHash).toBeTruthy();
      expect(
        await bcrypt.compare("StrongPass1!xyz", existing.passwordHash as any),
      ).toBe(true);
    });

    it("never touches credentials of an existing full user", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const existing = {
        id: DELEGATE_ID,
        passwordHash: "ORIGINAL",
        oidcSubject: null,
        role: "user",
      };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      manager.count.mockResolvedValue(2); // owns accounts -> full user
      installTransactionMock(manager);

      const res = await service.createDelegate(OWNER_ID, {
        email: "full@x.y",
        password: "StrongPass1!xyz",
      } as any);

      expect(existing.passwordHash).toBe("ORIGINAL");
      expect(res.temporaryPassword).toBeUndefined();
    });

    it("never touches credentials of a self-registered user with no data yet", async () => {
      // Reproduces the race where the front-end clicks Add before the
      // email-lookup debounce returns: dto.password is sent but the
      // target email belongs to a real user that just hasn't created
      // any accounts yet. mayManageCredentials must still be false.
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      const existing = {
        id: "d2",
        passwordHash: "USER-CHOSEN",
        oidcSubject: null,
        role: "user",
      };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      // ownsAccounts=0, ownsDelegations=0, alreadyDelegate=0 -- a fresh
      // self-registered user who is not yet anybody's delegate row.
      manager.count.mockResolvedValue(0);
      installTransactionMock(manager);

      const res = await service.createDelegate(OWNER_ID, {
        email: "fresh@x.y",
        password: "OwnerWouldOverwrite1!",
      } as any);

      expect(existing.passwordHash).toBe("USER-CHOSEN");
      expect(res.temporaryPassword).toBeUndefined();
    });

    it("logs (does not throw) when the invite email fails to send", async () => {
      usersRepo.findOne.mockResolvedValue({ id: OWNER_ID, email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: true });
      emailService.sendMail.mockRejectedValue(new Error("smtp down"));
      configService.get.mockReturnValue("http://app");
      const manager: any = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((_e: any, v: any) => v),
        save: jest.fn((v: any) => ({ id: "g-new", ...v })),
      };
      installTransactionMock(manager);
      const res = await service.createDelegate(OWNER_ID, {
        email: "new@x.y",
        sendInvite: true,
      } as any);
      expect(res.invited).toBe(true);
      await new Promise((r) => setImmediate(r));
      expect(emailService.sendMail).toHaveBeenCalled();
    });
  });

  describe("readableAccountIds", () => {
    it("returns the account ids of READ grants", async () => {
      grantsRepo.find.mockResolvedValue([
        { accountId: "a1" },
        { accountId: "a2" },
      ]);
      await expect(service.readableAccountIds("g1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
      expect(grantsRepo.find).toHaveBeenCalledWith({
        where: { delegationId: "g1", canRead: true },
        select: ["accountId"],
      });
    });
  });

  describe("hasTransactionalAccess", () => {
    it("is false when there are no readable accounts", async () => {
      grantsRepo.find.mockResolvedValue([]);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(false);
      expect(accountsRepo.count).not.toHaveBeenCalled();
    });

    it("is false when every readable account is an investment account", async () => {
      grantsRepo.find.mockResolvedValue([{ accountId: "a1" }]);
      accountsRepo.count.mockResolvedValue(0);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(false);
    });

    it("is true when at least one readable account is non-investment", async () => {
      grantsRepo.find.mockResolvedValue([
        { accountId: "a1" },
        { accountId: "a2" },
      ]);
      accountsRepo.count.mockResolvedValue(1);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(true);
    });
  });

  describe("hasAnyAccountAccess", () => {
    it("is false when the delegate has no readable account grant", async () => {
      grantsRepo.count.mockResolvedValue(0);
      await expect(service.hasAnyAccountAccess("g1")).resolves.toBe(false);
      expect(grantsRepo.count).toHaveBeenCalledWith({
        where: { delegationId: "g1", canRead: true },
      });
    });

    it("is true when the delegate can read at least one account", async () => {
      grantsRepo.count.mockResolvedValue(2);
      await expect(service.hasAnyAccountAccess("g1")).resolves.toBe(true);
    });
  });

  describe("delegate favourites overlay", () => {
    it("getDelegateFavourites maps accountId -> sortOrder", async () => {
      delegateFavouritesRepo.find.mockResolvedValue([
        { accountId: "a1", sortOrder: 0 },
        { accountId: "a2", sortOrder: 3 },
      ]);
      const map = await service.getDelegateFavourites(DELEGATE_ID);
      expect(map.get("a1")).toBe(0);
      expect(map.get("a2")).toBe(3);
      expect(map.size).toBe(2);
    });

    it("setDelegateFavourite removes the row when unfavouriting", async () => {
      await service.setDelegateFavourite(DELEGATE_ID, "a1", false);
      expect(delegateFavouritesRepo.delete).toHaveBeenCalledWith({
        delegateUserId: DELEGATE_ID,
        accountId: "a1",
      });
      expect(delegateFavouritesRepo.save).not.toHaveBeenCalled();
    });

    it("setDelegateFavourite is idempotent when already a favourite", async () => {
      delegateFavouritesRepo.findOne.mockResolvedValue({ id: "f1" });
      await service.setDelegateFavourite(DELEGATE_ID, "a1", true);
      expect(delegateFavouritesRepo.save).not.toHaveBeenCalled();
    });

    it("setDelegateFavourite inserts a new favourite", async () => {
      delegateFavouritesRepo.findOne.mockResolvedValue(null);
      await service.setDelegateFavourite(DELEGATE_ID, "a1", true);
      expect(delegateFavouritesRepo.save).toHaveBeenCalledWith({
        delegateUserId: DELEGATE_ID,
        accountId: "a1",
        sortOrder: 0,
      });
    });

    it("reorderDelegateFavourites rejects a non-array (CWE-834)", async () => {
      await expect(
        service.reorderDelegateFavourites(DELEGATE_ID, {
          length: 1e9,
        } as unknown as string[]),
      ).rejects.toThrow(/must be an array/);
    });

    it("reorderDelegateFavourites sets sortOrder by position", async () => {
      const manager = installTransactionMock({ update: jest.fn() });
      await service.reorderDelegateFavourites(DELEGATE_ID, ["a2", "a1"]);
      // The whole reorder is one transaction, so a partially applied order can
      // never be committed.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenNthCalledWith(
        1,
        DelegateAccountFavourite,
        { delegateUserId: DELEGATE_ID, accountId: "a2" },
        { sortOrder: 0 },
      );
      expect(manager.update).toHaveBeenNthCalledWith(
        2,
        DelegateAccountFavourite,
        { delegateUserId: DELEGATE_ID, accountId: "a1" },
        { sortOrder: 1 },
      );
    });
  });

  describe("resetDelegatePassword (missing delegate user)", () => {
    it("throws when the delegate user no longer exists", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: DELEGATE_ID,
      });
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resetDelegatePassword(OWNER_ID, "g1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
