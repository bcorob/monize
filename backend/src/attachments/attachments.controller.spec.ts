import { Response } from "express";
import {
  ALLOW_DELEGATE_KEY,
  DELEGATE_SECTION_KEY,
} from "../delegation/decorators/delegate-access.decorator";
import {
  AttachmentsController,
  contentDisposition,
} from "./attachments.controller";
import { AttachmentListItem, AttachmentsService } from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";

describe("AttachmentsController", () => {
  let controller: AttachmentsController;
  let service: jest.Mocked<
    Pick<
      AttachmentsService,
      | "create"
      | "findAllFor"
      | "getForDownload"
      | "updateDocumentKind"
      | "remove"
    >
  >;
  const req = { user: { id: "user-1" } };

  beforeEach(() => {
    service = {
      create: jest.fn(),
      findAllFor: jest.fn(),
      getForDownload: jest.fn(),
      updateDocumentKind: jest.fn(),
      remove: jest.fn(),
    };
    controller = new AttachmentsController(
      service as unknown as AttachmentsService,
    );
  });

  it("delegates upload to the service", async () => {
    const file = { originalname: "r.png" } as Express.Multer.File;
    const created = { id: "a1" } as TransactionAttachment;
    service.create.mockResolvedValue(created);

    const result = await controller.upload(req, "txn-1", { file: [file] });

    expect(result).toBe(created);
    expect(service.create).toHaveBeenCalledWith(
      "user-1",
      { kind: "transaction", id: "txn-1" },
      file,
      undefined,
    );
  });

  // The pair arrives as two named parts of one request, so the controller has
  // to hand both down -- an `original` dropped here would store the scan alone
  // and report success, which is the one outcome the feature exists to avoid.
  it("passes a scanned pair's original through as the second file", async () => {
    const file = { originalname: "r-scan.jpg" } as Express.Multer.File;
    const original = { originalname: "r.jpg" } as Express.Multer.File;
    const created = { id: "a1" } as TransactionAttachment;
    service.create.mockResolvedValue(created);

    await controller.upload(req, "txn-1", {
      file: [file],
      original: [original],
    });

    expect(service.create).toHaveBeenCalledWith(
      "user-1",
      { kind: "transaction", id: "txn-1" },
      file,
      original,
    );
  });

  // multer gives no part at all when the client sends none, and the service
  // owns the "empty upload" refusal -- the controller must reach it rather than
  // throwing a TypeError on the way.
  it("passes undefined through when the request carries no file part", async () => {
    service.create.mockResolvedValue({ id: "a1" } as TransactionAttachment);

    await controller.upload(req, "txn-1", {});

    expect(service.create).toHaveBeenCalledWith(
      "user-1",
      { kind: "transaction", id: "txn-1" },
      undefined,
      undefined,
    );
  });

  it("delegates list to the service", async () => {
    const rows = [
      { id: "a1", originalAttachmentId: null, warrantyName: null },
    ] as AttachmentListItem[];
    service.findAllFor.mockResolvedValue(rows);
    const result = await controller.findAll(req, "txn-1");
    expect(result).toBe(rows);
    expect(service.findAllFor).toHaveBeenCalledWith("user-1", {
      kind: "transaction",
      id: "txn-1",
    });
  });

  // One route per parent (WTY-003): the warranty routes name their parent by
  // kind, so the service can never be handed two ids, and the document kind
  // travels only on the warranty route.
  describe("the warranty routes", () => {
    it("uploads under the warranty with the document kind from the body", async () => {
      const file = { originalname: "manual.pdf" } as Express.Multer.File;
      const created = { id: "a2" } as TransactionAttachment;
      service.create.mockResolvedValue(created);

      const result = await controller.uploadForWarranty(
        req,
        "wty-1",
        { file: [file] },
        { documentKind: "manual" },
      );

      expect(result).toBe(created);
      expect(service.create).toHaveBeenCalledWith(
        "user-1",
        { kind: "warranty", id: "wty-1" },
        file,
        undefined,
        "manual",
      );
    });

    it("passes a scanned pair and an absent kind through unchanged", async () => {
      const file = { originalname: "r-scan.jpg" } as Express.Multer.File;
      const original = { originalname: "r.jpg" } as Express.Multer.File;
      service.create.mockResolvedValue({ id: "a2" } as TransactionAttachment);

      await controller.uploadForWarranty(
        req,
        "wty-1",
        { file: [file], original: [original] },
        {},
      );

      expect(service.create).toHaveBeenCalledWith(
        "user-1",
        { kind: "warranty", id: "wty-1" },
        file,
        original,
        undefined,
      );
    });

    it("lists under the warranty", async () => {
      const rows = [
        { id: "a2", originalAttachmentId: null },
      ] as AttachmentListItem[];
      service.findAllFor.mockResolvedValue(rows);

      const result = await controller.findAllForWarranty(req, "wty-1");

      expect(result).toBe(rows);
      expect(service.findAllFor).toHaveBeenCalledWith("user-1", {
        kind: "warranty",
        id: "wty-1",
      });
    });
  });

  it("streams a download with hardened headers", async () => {
    service.getForDownload.mockResolvedValue({
      data: Buffer.from("bytes"),
      contentType: "image/png",
      filename: "r.png",
      byteSize: 5,
    });
    const set = jest.fn();
    const end = jest.fn();
    const res = { set, end } as unknown as Response;

    await controller.download(req, "a1", res);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "image/png",
        "Content-Length": "5",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      }),
    );
    expect(end).toHaveBeenCalledWith(Buffer.from("bytes"));
    expect(service.getForDownload).toHaveBeenCalledWith("user-1", "a1", {
      isDelegate: false,
    });
  });

  it("tells the service when the downloader is an acting delegate", async () => {
    service.getForDownload.mockResolvedValue({
      data: Buffer.from("bytes"),
      contentType: "image/png",
      filename: "r.png",
      byteSize: 5,
    });
    const res = { set: jest.fn(), end: jest.fn() } as unknown as Response;

    await controller.download(
      { user: { id: "user-1", isActing: true, delegationId: "d1" } },
      "a1",
      res,
    );

    expect(service.getForDownload).toHaveBeenCalledWith("user-1", "a1", {
      isDelegate: true,
    });
  });

  it("admits a delegate to the warranty list and the download through the warranties section only", () => {
    const proto = AttachmentsController.prototype as unknown as Record<
      string,
      object
    >;
    for (const name of ["findAllForWarranty", "download"]) {
      expect([
        name,
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[name]),
        Reflect.getMetadata(DELEGATE_SECTION_KEY, proto[name]),
      ]).toEqual([name, true, "warranties"]);
    }
    for (const name of [
      "upload",
      "findAll",
      "uploadForWarranty",
      "updateDocumentKind",
      "remove",
    ]) {
      expect([
        name,
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[name]),
      ]).toEqual([name, undefined]);
    }
  });

  // The kind is the one field a document carries that the user can change
  // after upload; the service owns the parent check, so the controller hands
  // the owner, the id and the kind down and answers with the list row.
  it("delegates a document kind change to the service", async () => {
    const updated = {
      id: "a1",
      documentKind: "manual",
      originalAttachmentId: null,
      warrantyName: "Dishwasher",
    } as AttachmentListItem;
    service.updateDocumentKind.mockResolvedValue(updated);

    const result = await controller.updateDocumentKind(req, "a1", {
      documentKind: "manual",
    });

    expect(result).toBe(updated);
    expect(service.updateDocumentKind).toHaveBeenCalledWith(
      "user-1",
      "a1",
      "manual",
    );
  });

  it("delegates delete to the service", async () => {
    service.remove.mockResolvedValue(undefined);
    await controller.remove(req, "a1");
    expect(service.remove).toHaveBeenCalledWith("user-1", "a1");
  });
});

describe("contentDisposition", () => {
  it("uses a quoted ASCII filename plus a UTF-8 fallback", () => {
    expect(contentDisposition("receipt.png")).toBe(
      "attachment; filename=\"receipt.png\"; filename*=UTF-8''receipt.png",
    );
  });

  it("replaces non-ASCII in the quoted form and encodes the UTF-8 form", () => {
    const header = contentDisposition("reçu€.pdf");
    expect(header).toContain('filename="re_');
    expect(header).toContain("filename*=UTF-8''re%C3%A7u%E2%82%AC.pdf");
  });

  it("neutralises quotes and backslashes in the quoted form", () => {
    const header = contentDisposition('a"b\\c.png');
    expect(header).toContain('filename="a_b_c.png"');
  });
});
