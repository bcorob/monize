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
import { DelegationService } from "../delegation/delegation.service";
import { CreateWarrantyDto } from "./dto/create-warranty.dto";
import { WarrantiesController } from "./warranties.controller";
import { WarrantiesService } from "./warranties.service";
import { WarrantyImportService } from "./warranty-import.service";

const USER = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const DELEGATE = "77777777-7777-4777-8777-777777777777";
const DELEGATION = "88888888-8888-4888-8888-888888888888";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";

describe("WarrantiesController", () => {
  let controller: WarrantiesController;
  let service: Record<string, jest.Mock>;
  let delegationService: { readableAccountIds: jest.Mock };
  let importService: { run: jest.Mock };
  const req = { user: { id: USER, realUserId: USER } };
  const actingReq = {
    user: {
      id: USER,
      realUserId: DELEGATE,
      isActing: true,
      delegationId: DELEGATION,
    },
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
      summary: jest.fn().mockResolvedValue({ total: 0 }),
      findOne: jest.fn().mockResolvedValue({ id: W1 }),
      create: jest.fn().mockResolvedValue({ id: W1 }),
      update: jest.fn().mockResolvedValue({ id: W1 }),
      remove: jest.fn().mockResolvedValue(undefined),
      archive: jest.fn().mockResolvedValue({ id: W1 }),
      unarchive: jest.fn().mockResolvedValue({ id: W1 }),
    };
    delegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([ACCOUNT]),
    };
    importService = {
      run: jest.fn().mockResolvedValue({
        rows: [],
        created: 0,
        skippedColumns: [],
        dryRun: true,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WarrantiesController],
      providers: [
        { provide: WarrantiesService, useValue: service },
        { provide: DelegationService, useValue: delegationService },
        { provide: WarrantyImportService, useValue: importService },
      ],
    }).compile();
    controller = module.get(WarrantiesController);
  });

  it("takes the user id from the JWT on every route, never from the request", async () => {
    const dto = Object.assign(new CreateWarrantyDto(), {
      name: "Laptop",
      purchaseDate: "2026-10-01",
      isLifetime: true,
    });
    await controller.findAll(req, { status: "expiring" });
    await controller.summary(req);
    await controller.findOne(req, W1);
    await controller.create(req, dto);
    await controller.update(req, W1, { name: "Renamed" });
    await controller.remove(req, W1);
    await controller.archive(req, W1);
    await controller.unarchive(req, W1);

    expect(service.findAll).toHaveBeenCalledWith(
      USER,
      { status: "expiring" },
      { accountScope: undefined },
    );
    expect(service.summary).toHaveBeenCalledWith(USER);
    expect(service.findOne).toHaveBeenCalledWith(USER, W1, {
      accountScope: undefined,
    });
    expect(service.create).toHaveBeenCalledWith(USER, dto);
    expect(service.update).toHaveBeenCalledWith(USER, W1, { name: "Renamed" });
    expect(service.remove).toHaveBeenCalledWith(USER, W1);
    expect(service.archive).toHaveBeenCalledWith(USER, W1);
    expect(service.unarchive).toHaveBeenCalledWith(USER, W1);
  });

  it("answers the service's view", async () => {
    await expect(controller.findOne(req, W1)).resolves.toEqual({ id: W1 });
  });

  it("deletes with 204 and archives with 200", () => {
    const proto = WarrantiesController.prototype;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.remove)).toBe(204);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.archive)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.unarchive)).toBe(200);
  });

  it("is guarded by the JWT and mounted at /warranties", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WarrantiesController),
    ).toHaveLength(1);
    expect(Reflect.getMetadata(PATH_METADATA, WarrantiesController)).toBe(
      "warranties",
    );
  });

  it("declares GET summary before GET :id, which would take it as an id", () => {
    const getRoutes = Object.getOwnPropertyNames(WarrantiesController.prototype)
      .filter((name) => name !== "constructor")
      .map((name) => {
        const handler = (
          WarrantiesController.prototype as unknown as Record<string, object>
        )[name];
        return {
          method: Reflect.getMetadata(METHOD_METADATA, handler),
          path: Reflect.getMetadata(PATH_METADATA, handler),
        };
      })
      .filter((route) => route.method === RequestMethod.GET)
      .map((route) => route.path);
    expect(getRoutes.indexOf("summary")).toBeGreaterThanOrEqual(0);
    expect(getRoutes.indexOf("summary")).toBeLessThan(getRoutes.indexOf(":id"));
  });

  describe("POST /warranties/import", () => {
    const csvFile = (
      mimetype: string,
      body = "ProductName,PurchaseDate\nLaptop,2026-10-01\n",
    ): Express.Multer.File =>
      ({
        mimetype,
        buffer: Buffer.from(body, "utf8"),
      }) as Express.Multer.File;

    it("previews by default and passes the file's text and the JWT's user", async () => {
      await controller.importCsv(req, {}, csvFile("text/csv"));
      expect(importService.run).toHaveBeenCalledWith(
        USER,
        "ProductName,PurchaseDate\nLaptop,2026-10-01\n",
        { dryRun: true, skipInvalid: false },
      );
    });

    it("commits only when dryRun is false, with skipInvalid as given", async () => {
      await controller.importCsv(
        req,
        { dryRun: false, skipInvalid: true },
        csvFile("application/vnd.ms-excel"),
      );
      expect(importService.run).toHaveBeenCalledWith(USER, expect.any(String), {
        dryRun: false,
        skipInvalid: true,
      });
    });

    it("accepts text/plain with a charset parameter", async () => {
      await controller.importCsv(req, {}, csvFile("text/plain; charset=utf-8"));
      expect(importService.run).toHaveBeenCalled();
    });

    it("accepts the type a browser sends for a .csv its OS cannot name, and the older CSV spellings", async () => {
      for (const type of [
        "application/octet-stream",
        "application/csv",
        "text/x-csv",
      ]) {
        await controller.importCsv(req, {}, csvFile(type));
      }
      expect(importService.run).toHaveBeenCalledTimes(3);
    });

    it("refuses a missing file and a non-CSV content type before reading", () => {
      expect(() => controller.importCsv(req, {}, undefined)).toThrow(
        "Choose a CSV file to import",
      );
      expect(() =>
        controller.importCsv(req, {}, csvFile("application/pdf")),
      ).toThrow("The file must be a CSV file");
      expect(importService.run).not.toHaveBeenCalled();
    });

    it("is a POST answered with 200, declared before the :id routes", () => {
      const proto = WarrantiesController.prototype;
      expect(Reflect.getMetadata(METHOD_METADATA, proto.importCsv)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, proto.importCsv)).toBe(
        "import",
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.importCsv)).toBe(
        200,
      );
      const names = Object.getOwnPropertyNames(proto);
      expect(names.indexOf("importCsv")).toBeLessThan(names.indexOf("findOne"));
    });
  });

  describe("the delegate section (design decision 9)", () => {
    const handlerOf = (name: string): object =>
      (WarrantiesController.prototype as unknown as Record<string, object>)[
        name
      ];

    it("admits a delegate to the reads through the warranties section and to nothing else", () => {
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, WarrantiesController),
      ).toBeUndefined();
      const reads = ["findAll", "summary", "findOne"];
      for (const name of reads) {
        expect([
          name,
          Reflect.getMetadata(ALLOW_DELEGATE_KEY, handlerOf(name)),
          Reflect.getMetadata(DELEGATE_SECTION_KEY, handlerOf(name)),
        ]).toEqual([name, true, "warranties"]);
      }
      const writes = Object.getOwnPropertyNames(
        WarrantiesController.prototype,
      ).filter((name) => name !== "constructor" && !reads.includes(name));
      expect(writes).toEqual([
        "importCsv",
        "create",
        "update",
        "remove",
        "archive",
        "unarchive",
      ]);
      for (const name of writes) {
        expect([
          name,
          Reflect.getMetadata(ALLOW_DELEGATE_KEY, handlerOf(name)),
        ]).toEqual([name, undefined]);
      }
    });

    it("resolves the delegate's readable accounts once and hands them to the read (WTY-007)", async () => {
      await controller.findAll(actingReq, {});
      await controller.findOne(actingReq, W1);

      expect(delegationService.readableAccountIds).toHaveBeenCalledWith(
        DELEGATION,
      );
      expect(service.findAll).toHaveBeenCalledWith(
        USER,
        {},
        { accountScope: [ACCOUNT] },
      );
      expect(service.findOne).toHaveBeenCalledWith(USER, W1, {
        accountScope: [ACCOUNT],
      });
    });

    it("gives an acting delegate without a delegation an empty scope, never the owner's", async () => {
      await controller.findAll(
        { user: { id: USER, realUserId: DELEGATE, isActing: true } },
        {},
      );
      expect(delegationService.readableAccountIds).not.toHaveBeenCalled();
      expect(service.findAll).toHaveBeenCalledWith(
        USER,
        {},
        { accountScope: [] },
      );
    });
  });
});
