import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  type ExecutionContext,
} from "@nestjs/common";
import { Subject, lastValueFrom, of, throwError } from "rxjs";
import {
  EMAIL_IMPORT_FILE_LIMIT_MB,
  EMAIL_IMPORT_REQUEST_LIMIT_BYTES,
  EmailReceiptUploadErrorInterceptor,
} from "../import/email-receipt-upload-error.interceptor";
import type { EmailReceiptImportResult } from "../import/email-receipt-import.service";
import { EmailReceiptMailboxController } from "./email-receipt-mailbox.controller";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";

/** An HTTP context whose request declares `length` as its Content-Length. */
const httpContext = (length: string | undefined, userId?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: length === undefined ? {} : { "content-length": length },
        ...(userId === undefined ? {} : { user: { id: userId } }),
      }),
    }),
  }) as unknown as ExecutionContext;

describe("EmailReceiptMailboxController", () => {
  const req = { user: { id: "user-1" } };
  const mailbox = {
    getView: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
    testConnection: jest.fn(),
    updateSettings: jest.fn(),
  };
  const poll = { pollNow: jest.fn() };
  const importer = { importFiles: jest.fn() };
  const controller = new EmailReceiptMailboxController(
    mailbox as never,
    poll as never,
    importer as never,
  );
  const proto = EmailReceiptMailboxController.prototype;

  beforeEach(() => jest.clearAllMocks());

  it("reads the JWT user's mailbox", async () => {
    mailbox.getView.mockResolvedValue({ id: "m1" });
    await expect(controller.get(req)).resolves.toEqual({ id: "m1" });
    expect(mailbox.getView).toHaveBeenCalledWith("user-1");
  });

  it("saves for the JWT user, never for a user in the body", async () => {
    mailbox.upsert.mockResolvedValue({ id: "m1" });
    const dto = { host: "h", userId: "someone-else" } as never;
    await controller.upsert(req, dto);
    expect(mailbox.upsert).toHaveBeenCalledWith("user-1", dto);
  });

  it("changes settings for the JWT user, never for a user in the body", async () => {
    mailbox.updateSettings.mockResolvedValue({ id: "m1" });
    const dto = { enabled: false, userId: "someone-else" } as never;
    await expect(controller.updateSettings(req, dto)).resolves.toEqual({
      id: "m1",
    });
    expect(mailbox.updateSettings).toHaveBeenCalledWith("user-1", dto);
    expect(Reflect.getMetadata("path", proto.updateSettings)).toBe("settings");
  });

  it("deletes for the JWT user", async () => {
    mailbox.remove.mockResolvedValue(undefined);
    await expect(controller.remove(req)).resolves.toBeUndefined();
    expect(mailbox.remove).toHaveBeenCalledWith("user-1");
  });

  it("tests a draft for the JWT user", async () => {
    mailbox.testConnection.mockResolvedValue({ ok: true, messages: 3 });
    const dto = { host: "h" } as never;
    await expect(controller.test(req, dto)).resolves.toEqual({
      ok: true,
      messages: 3,
    });
    expect(mailbox.testConnection).toHaveBeenCalledWith("user-1", dto);
  });

  it("polls now for the JWT user", async () => {
    const result = { ok: true, fetched: 2, skipped: 0, processed: 2 };
    poll.pollNow.mockResolvedValue(result);
    await expect(controller.pollNow(req)).resolves.toEqual(result);
    expect(poll.pollNow).toHaveBeenCalledWith("user-1");
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptMailboxController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptMailboxController),
    ).toBe(false);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
      ).not.toBe(true);
    }
  });

  it("throttles the connection test, the save and poll now", () => {
    const limitOf = (name: string) =>
      Reflect.getMetadata("THROTTLER:LIMITdefault", (proto as never)[name]) as
        number | undefined;
    expect(limitOf("test")).toBe(5);
    expect(limitOf("pollNow")).toBe(3);
    expect(limitOf("upsert")).toBe(10);
    expect(limitOf("updateSettings")).toBe(20);
    expect(limitOf("importArchive")).toBe(30);
  });

  describe("import", () => {
    const result: EmailReceiptImportResult = {
      files: [],
      truncated: 0,
      processed: 0,
      busy: false,
    };

    it("imports the uploaded files for the JWT user", async () => {
      importer.importFiles.mockResolvedValue(result);
      const files = [
        { originalname: "a.eml", buffer: Buffer.from("x") },
      ] as Express.Multer.File[];
      await expect(controller.importArchive(req, files, {})).resolves.toBe(
        result,
      );
      expect(importer.importFiles).toHaveBeenCalledWith("user-1", files, {
        process: true,
      });
    });

    it("passes process=true and process=false to the service", async () => {
      importer.importFiles.mockResolvedValue(result);
      const files = [
        { originalname: "a.eml", buffer: Buffer.from("x") },
      ] as Express.Multer.File[];
      await controller.importArchive(req, files, { process: "true" });
      expect(importer.importFiles).toHaveBeenLastCalledWith("user-1", files, {
        process: true,
      });
      await controller.importArchive(req, files, { process: "false" });
      expect(importer.importFiles).toHaveBeenLastCalledWith("user-1", files, {
        process: false,
      });
    });

    it("refuses a request with no file, before the service is called", () => {
      expect(() => controller.importArchive(req, undefined, {})).toThrow(
        BadRequestException,
      );
      expect(() => controller.importArchive(req, [], {})).toThrow(
        BadRequestException,
      );
      expect(importer.importFiles).not.toHaveBeenCalled();
    });

    it("answers 200 on the route import", () => {
      expect(Reflect.getMetadata("path", proto.importArchive)).toBe("import");
      expect(Reflect.getMetadata("__httpCode__", proto.importArchive)).toBe(
        200,
      );
    });

    it("turns multer's size error into a 413 naming the limit", async () => {
      const interceptor = new EmailReceiptUploadErrorInterceptor();
      const failing = {
        handle: () =>
          throwError(() => new PayloadTooLargeException("File too large")),
      };
      const error = await lastValueFrom(
        interceptor.intercept(httpContext("1024"), failing),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PayloadTooLargeException);
      expect(
        JSON.stringify((error as PayloadTooLargeException).getResponse()),
      ).toContain(String(EMAIL_IMPORT_FILE_LIMIT_MB));
    });

    it("refuses a body declared above the request limit before multer runs", async () => {
      const interceptor = new EmailReceiptUploadErrorInterceptor();
      const handle = jest.fn(() => of("ok"));
      for (const length of [String(EMAIL_IMPORT_REQUEST_LIMIT_BYTES + 1)]) {
        const error = await lastValueFrom(
          interceptor.intercept(httpContext(length), { handle }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PayloadTooLargeException);
        expect(
          JSON.stringify((error as PayloadTooLargeException).getResponse()),
        ).toContain("emailReceiptImportRequestTooLarge");
      }
      expect(handle).not.toHaveBeenCalled();
      // At the limit, and undeclared or unreadable (the frontend route bounds those).
      for (const length of [
        String(EMAIL_IMPORT_REQUEST_LIMIT_BYTES),
        undefined,
        "abc",
      ]) {
        await expect(
          lastValueFrom(interceptor.intercept(httpContext(length), { handle })),
        ).resolves.toBe("ok");
      }
    });

    it("holds one import per user at a time, before multer reads the body", async () => {
      const interceptor = new EmailReceiptUploadErrorInterceptor();
      const running = new Subject<string>();
      const first = lastValueFrom(
        interceptor.intercept(httpContext("1024", "user-a"), {
          handle: () => running,
        }),
      );
      const handle = jest.fn(() => of("second"));
      const refused = await lastValueFrom(
        interceptor.intercept(httpContext("1024", "user-a"), { handle }),
      ).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(429);
      expect(
        JSON.stringify((refused as HttpException).getResponse()),
      ).toContain("emailReceiptImportInProgress");
      expect(handle).not.toHaveBeenCalled();
      // Another user is not held by it.
      await expect(
        lastValueFrom(
          interceptor.intercept(httpContext("1024", "user-b"), { handle }),
        ),
      ).resolves.toBe("second");

      running.next("done");
      running.complete();
      await expect(first).resolves.toBe("done");
      // Released after it finished, and after a failure too.
      await expect(
        lastValueFrom(
          interceptor.intercept(httpContext("1024", "user-a"), {
            handle: () => throwError(() => new Error("boom")),
          }),
        ),
      ).rejects.toThrow("boom");
      await expect(
        lastValueFrom(
          interceptor.intercept(httpContext("1024", "user-a"), { handle }),
        ),
      ).resolves.toBe("second");
    });

    it("passes other errors and results through", async () => {
      const interceptor = new EmailReceiptUploadErrorInterceptor();
      const boom = new Error("boom");
      await expect(
        lastValueFrom(
          interceptor.intercept(httpContext("1024"), {
            handle: () => throwError(() => boom),
          }),
        ),
      ).rejects.toBe(boom);
      await expect(
        lastValueFrom(
          interceptor.intercept(httpContext("1024"), {
            handle: () => of("ok"),
          }),
        ),
      ).resolves.toBe("ok");
    });
  });
});
