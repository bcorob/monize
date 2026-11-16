import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { lockWarrantyRow } from "../common/db/locks";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { CreateWarrantyClaimDto } from "./dto/create-warranty-claim.dto";
import { UpdateWarrantyClaimDto } from "./dto/update-warranty-claim.dto";
import { WarrantyClaim } from "./entities/warranty-claim.entity";
import { Warranty } from "./entities/warranty.entity";
import { WarrantyClaimsService } from "./warranty-claims.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

const USER = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const FOREIGN_W = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";
const C2 = "55555555-5555-4555-8555-555555555555";

const lockWarranty = lockWarrantyRow as jest.Mock;

function claim(overrides: Partial<WarrantyClaim> = {}): WarrantyClaim {
  return {
    id: C1,
    userId: USER,
    warrantyId: W1,
    claimDate: "2026-10-01",
    status: "open",
    description: "Screen flickers",
    resolution: null,
    resolvedOn: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("WarrantyClaimsService", () => {
  let service: WarrantyClaimsService;
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let warrantyRepo: Record<string, jest.Mock>;
  let claimRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    lockWarranty.mockReset();
    // The caller owns W1 and nothing else.
    lockWarranty.mockImplementation(
      async (_m: unknown, id: string, userId: string) =>
        id === W1 && userId === USER ? { id } : null,
    );
    warrantyRepo = {
      findOne: jest.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === W1 && where.userId === USER ? { id: W1 } : null,
      ),
    };
    claimRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<WarrantyClaim>) => value),
      save: jest.fn(async (value: Partial<WarrantyClaim>) => ({
        id: C1,
        createdAt: new Date("2026-10-21T12:00:00.000Z"),
        updatedAt: new Date("2026-10-21T12:00:00.000Z"),
        ...value,
      })),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
    mocks = createScopedDbMocks([
      [Warranty, warrantyRepo],
      [WarrantyClaim, claimRepo],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarrantyClaimsService,
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();
    service = module.get(WarrantyClaimsService);
  });

  const createDto = (
    overrides: Partial<CreateWarrantyClaimDto> = {},
  ): CreateWarrantyClaimDto =>
    Object.assign(new CreateWarrantyClaimDto(), {
      claimDate: "2026-10-21",
      ...overrides,
    });

  const updateDto = (
    overrides: Partial<UpdateWarrantyClaimDto>,
  ): UpdateWarrantyClaimDto =>
    Object.assign(new UpdateWarrantyClaimDto(), overrides);

  describe("findAll", () => {
    it("lists the owned warranty's claims newest first, as camelCase views", async () => {
      claimRepo.find.mockResolvedValue([
        claim({
          id: C2,
          claimDate: "2026-10-15",
          status: "resolved",
          resolution: "Replaced",
          resolvedOn: "2026-10-20",
        }),
        claim(),
      ]);

      const result = await service.findAll(USER, W1);

      expect(warrantyRepo.findOne).toHaveBeenCalledWith({
        where: { id: W1, userId: USER },
        select: { id: true },
      });
      expect(claimRepo.find).toHaveBeenCalledWith({
        where: { warrantyId: W1, userId: USER },
        order: { claimDate: "DESC", createdAt: "DESC" },
      });
      expect(result).toEqual([
        {
          id: C2,
          warrantyId: W1,
          claimDate: "2026-10-15",
          status: "resolved",
          description: "Screen flickers",
          resolution: "Replaced",
          resolvedOn: "2026-10-20",
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-01T12:00:00.000Z",
        },
        expect.objectContaining({ id: C1, status: "open", resolvedOn: null }),
      ]);
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("refuses a warranty that is not the caller's with a 404 and reads no claims", async () => {
      await expect(service.findAll(USER, FOREIGN_W)).rejects.toThrow(
        NotFoundException,
      );
      expect(claimRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("locks the owned warranty and inserts an open claim in one transaction", async () => {
      const view = await service.create(
        USER,
        W1,
        createDto({ description: "  Hinge cracked  ", resolution: "" }),
      );

      expect(lockWarranty).toHaveBeenCalledWith(mocks.manager, W1, USER);
      expect(claimRepo.create).toHaveBeenCalledWith({
        userId: USER,
        warrantyId: W1,
        claimDate: "2026-10-21",
        status: "open",
        resolvedOn: null,
        description: "Hinge cracked",
        resolution: null,
      });
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(view).toMatchObject({
        id: C1,
        warrantyId: W1,
        status: "open",
        description: "Hinge cracked",
        createdAt: "2026-10-21T12:00:00.000Z",
      });
    });

    it("stores a closed claim with its resolution date", async () => {
      await service.create(
        USER,
        W1,
        createDto({
          claimDate: "2026-10-01",
          status: "denied",
          resolvedOn: "2026-10-01",
        }),
      );
      expect(claimRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: "denied", resolvedOn: "2026-10-01" }),
      );
    });

    it("refuses a foreign warranty with a 404 and writes nothing (WTY-005)", async () => {
      await expect(
        service.create(USER, FOREIGN_W, createDto()),
      ).rejects.toThrow(NotFoundException);
      expect(lockWarranty).toHaveBeenCalledWith(mocks.manager, FOREIGN_W, USER);
      expect(claimRepo.save).not.toHaveBeenCalled();
    });

    it.each(["open", "approved"] as const)(
      "refuses a resolution date on a %s claim",
      async (status) => {
        await expect(
          service.create(
            USER,
            W1,
            createDto({ status, resolvedOn: "2026-10-22" }),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(claimRepo.save).not.toHaveBeenCalled();
      },
    );

    it("refuses a resolution date before the claim date", async () => {
      await expect(
        service.create(
          USER,
          W1,
          createDto({ status: "resolved", resolvedOn: "2026-10-20" }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(claimRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("closes a claim, writing only what moved", async () => {
      claimRepo.findOne.mockResolvedValue(claim());

      const view = await service.update(
        USER,
        W1,
        C1,
        updateDto({
          claimDate: "2026-10-01",
          status: "resolved",
          description: "Screen flickers",
          resolution: "Panel replaced",
          resolvedOn: "2026-10-10",
        }),
      );

      expect(lockWarranty).toHaveBeenCalledWith(mocks.manager, W1, USER);
      expect(claimRepo.findOne).toHaveBeenCalledWith({
        where: { id: C1, warrantyId: W1, userId: USER },
      });
      expect(claimRepo.save).toHaveBeenCalledWith({
        ...claim(),
        status: "resolved",
        resolution: "Panel replaced",
        resolvedOn: "2026-10-10",
      });
      expect(view).toMatchObject({
        status: "resolved",
        resolvedOn: "2026-10-10",
      });
      expect(mocks.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("does not write a claim the payload leaves unchanged", async () => {
      claimRepo.findOne.mockResolvedValue(claim());
      const view = await service.update(
        USER,
        W1,
        C1,
        updateDto({ claimDate: "2026-10-01", status: "open" }),
      );
      expect(claimRepo.save).not.toHaveBeenCalled();
      expect(view.id).toBe(C1);
    });

    it("clears a resolution date and reopens the claim together", async () => {
      claimRepo.findOne.mockResolvedValue(
        claim({ status: "denied", resolvedOn: "2026-10-05" }),
      );
      await service.update(
        USER,
        W1,
        C1,
        updateDto({ status: "open", resolvedOn: null }),
      );
      expect(claimRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: "open", resolvedOn: null }),
      );
    });

    it("refuses reopening a claim that keeps its stored resolution date", async () => {
      claimRepo.findOne.mockResolvedValue(
        claim({ status: "denied", resolvedOn: "2026-10-05" }),
      );
      await expect(
        service.update(USER, W1, C1, updateDto({ status: "approved" })),
      ).rejects.toThrow(BadRequestException);
      expect(claimRepo.save).not.toHaveBeenCalled();
    });

    it("refuses moving the claim date past the stored resolution date", async () => {
      claimRepo.findOne.mockResolvedValue(
        claim({ status: "resolved", resolvedOn: "2026-10-05" }),
      );
      await expect(
        service.update(USER, W1, C1, updateDto({ claimDate: "2026-10-06" })),
      ).rejects.toThrow(BadRequestException);
      expect(claimRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a foreign warranty with a 404 before reading the claim", async () => {
      await expect(
        service.update(USER, FOREIGN_W, C1, updateDto({ status: "approved" })),
      ).rejects.toThrow(NotFoundException);
      expect(claimRepo.findOne).not.toHaveBeenCalled();
      expect(claimRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a claim that is not under the named warranty with a 404", async () => {
      await expect(
        service.update(USER, W1, C2, updateDto({ status: "approved" })),
      ).rejects.toThrow(NotFoundException);
      expect(claimRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes the claim scoped to the owned warranty and the caller", async () => {
      await service.remove(USER, W1, C1);
      expect(lockWarranty).toHaveBeenCalledWith(mocks.manager, W1, USER);
      expect(claimRepo.delete).toHaveBeenCalledWith({
        id: C1,
        warrantyId: W1,
        userId: USER,
      });
    });

    it("refuses a foreign warranty with a 404 and deletes nothing (WTY-005)", async () => {
      await expect(service.remove(USER, FOREIGN_W, C1)).rejects.toThrow(
        NotFoundException,
      );
      expect(claimRepo.delete).not.toHaveBeenCalled();
    });

    it("answers 404 when no claim matched", async () => {
      claimRepo.delete.mockResolvedValue({ affected: 0, raw: [] });
      await expect(service.remove(USER, W1, C2)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
