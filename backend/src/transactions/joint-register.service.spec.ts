import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { JointRegisterService } from "./joint-register.service";
import { Transaction } from "./entities/transaction.entity";
import { AccountDelegate } from "../delegation/entities/account-delegate.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("JointRegisterService", () => {
  let service: JointRegisterService;
  let jointAccounts: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let txRepo: Record<string, jest.Mock>;
  let delegatesRepo: Record<string, jest.Mock>;

  const GRANTEE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const TX_ID = "44444444-4444-4444-8444-444444444444";

  const access = {
    account: { id: ACCOUNT_ID, userId: OWNER, accountType: "CHEQUING" },
    ownerUserId: OWNER,
    via: "delegation" as const,
  };

  const plainRow = {
    id: TX_ID,
    accountId: ACCOUNT_ID,
    userId: OWNER,
    isTransfer: false,
    isSplit: false,
    parentTransactionId: null,
  } as unknown as Transaction;

  let crossOwnerAccess: { assertAccessStillHeld: jest.Mock };

  beforeEach(() => {
    txRepo = { findOne: jest.fn(), exists: jest.fn() };
    delegatesRepo = { findOne: jest.fn() };
    const scoped = createScopedDbMocks([
      [Transaction, txRepo as never],
      [AccountDelegate, delegatesRepo as never],
    ]);
    jointAccounts = { jointAccessFor: jest.fn().mockResolvedValue(access) };
    transactionsService = {
      createWithOutcome: jest
        .fn()
        .mockResolvedValue({ transaction: { id: TX_ID }, created: true }),
      update: jest.fn().mockResolvedValue({ id: TX_ID }),
      remove: jest.fn().mockResolvedValue(undefined),
      markCleared: jest.fn().mockResolvedValue({ id: TX_ID }),
    };
    crossOwnerAccess = {
      assertAccessStillHeld: jest.fn().mockResolvedValue(undefined),
    };
    service = new JointRegisterService(
      scoped.dataSource as never,
      jointAccounts as never,
      transactionsService as never,
      crossOwnerAccess as never,
    );
  });

  describe("create", () => {
    const dto = {
      accountId: ACCOUNT_ID,
      amount: -25,
      transactionDate: "2026-08-01",
      payeeId: "p1",
    };

    it("authorizes create then runs the owner-scoped operation", async () => {
      await service.create(GRANTEE, dto as never);

      expect(jointAccounts.jointAccessFor).toHaveBeenCalledWith(
        GRANTEE,
        ACCOUNT_ID,
        "create",
      );
      // The reused operation runs AS THE OWNER -- the row, its balance
      // update and net-worth recalc all land on the owner's ledger.
      expect(transactionsService.createWithOutcome).toHaveBeenCalledWith(
        OWNER,
        dto,
        {
          createPayeeIfMissing: false,
          // Set from the joint grant, never from the request: the owner's
          // structural rules must not run on a grantee's row.
          actorIsNotOwner: true,
          // The grant re-asserted inside the write's transaction (A26-M04).
          beforeWrite: expect.any(Function),
        },
      );
    });

    it("re-asserts the joint create grant inside the write's transaction (A26-M04)", async () => {
      await service.create(GRANTEE, dto as never);
      const [, , options] = transactionsService.createWithOutcome.mock.calls[0];
      const m = { query: jest.fn() };
      await options.beforeWrite(m);
      expect(crossOwnerAccess.assertAccessStillHeld).toHaveBeenCalledWith(
        m,
        GRANTEE,
        ACCOUNT_ID,
        "create",
        { joint: true },
      );
    });

    it("returns the created row, and passes on whether it already existed", async () => {
      await expect(service.create(GRANTEE, dto as never)).resolves.toEqual({
        id: TX_ID,
      });
      transactionsService.createWithOutcome.mockResolvedValueOnce({
        transaction: { id: TX_ID },
        created: false,
      });
      await expect(
        service.createWithOutcome(GRANTEE, {
          ...dto,
          externalId: "bank-1",
        } as never),
      ).resolves.toEqual({ transaction: { id: TX_ID }, created: false });
    });

    it("refuses before writing when the grant is missing", async () => {
      jointAccounts.jointAccessFor.mockRejectedValue(new NotFoundException());
      await expect(
        service.create(GRANTEE, dto as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(transactionsService.createWithOutcome).not.toHaveBeenCalled();
    });

    it("rejects grantee tagIds with no write (tags are per-user)", async () => {
      await expect(
        service.create(GRANTEE, { ...dto, tagIds: ["t1"] } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(jointAccounts.jointAccessFor).not.toHaveBeenCalled();
      expect(transactionsService.createWithOutcome).not.toHaveBeenCalled();
    });

    it("rejects splits with no write", async () => {
      await expect(
        service.create(GRANTEE, {
          ...dto,
          splits: [{ amount: -25 }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionsService.createWithOutcome).not.toHaveBeenCalled();
    });

    describe("free-text payee policy", () => {
      const freeText = {
        accountId: ACCOUNT_ID,
        amount: -10,
        transactionDate: "2026-08-01",
        payeeName: "Corner Store",
      } as never;

      it("auto-creates on the owner's ledger when the delegation allows it", async () => {
        delegatesRepo.findOne.mockResolvedValue({
          id: "d1",
          payeesCanCreate: true,
        });
        await service.create(GRANTEE, freeText);
        expect(transactionsService.createWithOutcome).toHaveBeenCalledWith(
          OWNER,
          freeText,
          {
            createPayeeIfMissing: true,
            actorIsNotOwner: true,
            beforeWrite: expect.any(Function),
          },
        );
      });

      it("403s free text without the capability -- never stores unlinked text on owner rows", async () => {
        delegatesRepo.findOne.mockResolvedValue({
          id: "d1",
          payeesCanCreate: false,
        });
        await expect(service.create(GRANTEE, freeText)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(transactionsService.createWithOutcome).not.toHaveBeenCalled();
      });
    });
  });

  describe("update", () => {
    const dto = { amount: -30 } as never;

    beforeEach(() => {
      txRepo.findOne.mockResolvedValue(plainRow);
    });

    it("authorizes edit on the row's account then updates as the owner", async () => {
      await service.update(GRANTEE, TX_ID, dto);
      expect(jointAccounts.jointAccessFor).toHaveBeenCalledWith(
        GRANTEE,
        ACCOUNT_ID,
        "edit",
      );
      expect(transactionsService.update).toHaveBeenCalledWith(
        OWNER,
        TX_ID,
        dto,
        { createPayeeIfMissing: false, beforeWrite: expect.any(Function) },
      );
    });

    it("refuses inside the write when the owner moved the row out of the joint account (A26-M04)", async () => {
      txRepo.findOne.mockResolvedValue(plainRow);
      await service.update(GRANTEE, TX_ID, { description: "x" } as never);
      const [, , , options] = transactionsService.update.mock.calls[0];
      const m = {
        query: jest.fn().mockResolvedValue([{ account_id: "elsewhere" }]),
      };
      await expect(options.beforeWrite(m)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(crossOwnerAccess.assertAccessStillHeld).not.toHaveBeenCalled();
    });

    it("404s an unknown row without consulting grants", async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(service.update(GRANTEE, TX_ID, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(jointAccounts.jointAccessFor).not.toHaveBeenCalled();
    });

    it("rejects account moves before authorization or write", async () => {
      await expect(
        service.update(GRANTEE, TX_ID, {
          accountId: "55555555-5555-4555-8555-555555555555",
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("locks transfer rows to the transfer editor", async () => {
      txRepo.findOne.mockResolvedValue({ ...plainRow, isTransfer: true });
      await expect(service.update(GRANTEE, TX_ID, dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("locks split rows to the owner", async () => {
      txRepo.findOne.mockResolvedValue({ ...plainRow, isSplit: true });
      await expect(service.update(GRANTEE, TX_ID, dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("propagates a 403 for a read-only grant with no write", async () => {
      jointAccounts.jointAccessFor.mockRejectedValue(new ForbiddenException());
      await expect(service.update(GRANTEE, TX_ID, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(transactionsService.update).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    beforeEach(() => {
      txRepo.findOne.mockResolvedValue(plainRow);
    });

    it("authorizes delete then removes as the owner", async () => {
      await service.remove(GRANTEE, TX_ID);
      expect(jointAccounts.jointAccessFor).toHaveBeenCalledWith(
        GRANTEE,
        ACCOUNT_ID,
        "delete",
      );
      expect(transactionsService.remove).toHaveBeenCalledWith(OWNER, TX_ID, {
        beforeWrite: expect.any(Function),
      });
      const [, , options] = transactionsService.remove.mock.calls[0];
      const m = {
        query: jest.fn().mockResolvedValue([{ account_id: ACCOUNT_ID }]),
      };
      await options.beforeWrite(m);
      expect(crossOwnerAccess.assertAccessStillHeld).toHaveBeenCalledWith(
        m,
        GRANTEE,
        ACCOUNT_ID,
        "delete",
        { joint: true },
      );
    });

    it("locks transfer rows", async () => {
      txRepo.findOne.mockResolvedValue({ ...plainRow, isTransfer: true });
      await expect(service.remove(GRANTEE, TX_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transactionsService.remove).not.toHaveBeenCalled();
    });
  });

  describe("markCleared", () => {
    it("treats the cleared toggle as an edit on the owner's row", async () => {
      txRepo.findOne.mockResolvedValue(plainRow);
      await service.markCleared(GRANTEE, TX_ID, true);
      expect(jointAccounts.jointAccessFor).toHaveBeenCalledWith(
        GRANTEE,
        ACCOUNT_ID,
        "edit",
      );
      expect(transactionsService.markCleared).toHaveBeenCalledWith(
        OWNER,
        TX_ID,
        true,
        { beforeWrite: expect.any(Function) },
      );
    });
  });

  describe("ownsRow", () => {
    it("is a plain owner-scoped existence probe", async () => {
      txRepo.exists.mockResolvedValue(true);
      await expect(service.ownsRow(GRANTEE, TX_ID)).resolves.toBe(true);
      expect(txRepo.exists).toHaveBeenCalledWith({
        where: { id: TX_ID, userId: GRANTEE },
      });
    });
  });
});
