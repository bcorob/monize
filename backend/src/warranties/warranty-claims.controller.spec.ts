import { Test, TestingModule } from "@nestjs/testing";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";

import {
  ALLOW_DELEGATE_KEY,
  DELEGATE_SECTION_KEY,
} from "../delegation/decorators/delegate-access.decorator";
import { CreateWarrantyClaimDto } from "./dto/create-warranty-claim.dto";
import { WarrantyClaimsController } from "./warranty-claims.controller";
import { WarrantyClaimsService } from "./warranty-claims.service";

const USER = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const C1 = "44444444-4444-4444-8444-444444444444";

function handler(name: string): object {
  return (
    WarrantyClaimsController.prototype as unknown as Record<string, object>
  )[name];
}

describe("WarrantyClaimsController", () => {
  let controller: WarrantyClaimsController;
  let service: Record<string, jest.Mock>;
  const req = { user: { id: USER, realUserId: USER } };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue([{ id: C1 }]),
      create: jest.fn().mockResolvedValue({ id: C1 }),
      update: jest.fn().mockResolvedValue({ id: C1 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WarrantyClaimsController],
      providers: [{ provide: WarrantyClaimsService, useValue: service }],
    }).compile();
    controller = module.get(WarrantyClaimsController);
  });

  it("takes the user id from the JWT and the warranty from the route", async () => {
    const dto = Object.assign(new CreateWarrantyClaimDto(), {
      claimDate: "2026-10-21",
    });
    await expect(controller.findAll(req, W1)).resolves.toEqual([{ id: C1 }]);
    await controller.create(req, W1, dto);
    await controller.update(req, W1, C1, { status: "approved" });
    await controller.remove(req, W1, C1);

    expect(service.findAll).toHaveBeenCalledWith(USER, W1);
    expect(service.create).toHaveBeenCalledWith(USER, W1, dto);
    expect(service.update).toHaveBeenCalledWith(USER, W1, C1, {
      status: "approved",
    });
    expect(service.remove).toHaveBeenCalledWith(USER, W1, C1);
  });

  it("is guarded by the JWT and mounted under /warranties/:id/claims", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WarrantyClaimsController),
    ).toHaveLength(1);
    expect(Reflect.getMetadata(PATH_METADATA, WarrantyClaimsController)).toBe(
      "warranties/:id/claims",
    );
  });

  it.each([
    ["findAll", RequestMethod.GET, "/"],
    ["create", RequestMethod.POST, "/"],
    ["update", RequestMethod.PATCH, ":claimId"],
    ["remove", RequestMethod.DELETE, ":claimId"],
  ])("routes %s", (name, method, path) => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler(name))).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler(name))).toBe(path);
  });

  it("deletes with 204", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler("remove"))).toBe(
      204,
    );
  });

  it("admits a delegate to the list through the warranties section and to no mutation (design decision 9)", () => {
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, WarrantyClaimsController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_DELEGATE_KEY, handler("findAll"))).toBe(
      true,
    );
    expect(Reflect.getMetadata(DELEGATE_SECTION_KEY, handler("findAll"))).toBe(
      "warranties",
    );
    for (const name of ["create", "update", "remove"]) {
      expect([
        name,
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, handler(name)),
      ]).toEqual([name, undefined]);
    }
  });
});
