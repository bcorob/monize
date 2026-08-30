import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { BackupController } from "./backup.controller";
import { RestoreQueueBusyException } from "./restore-processing-gate";
import {
  RESTORE_TICKET_HEADER,
  createRestoreTicketAuthorizer,
  verifyRestoreUploadTicket,
} from "./restore-upload-ticket";
import { RESTORE_RETRY_AFTER_SECONDS } from "./restore-queue-config";
import { BackupService } from "./backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";

describe("BackupController", () => {
  let controller: BackupController;
  let mockBackupService: Record<string, jest.Mock>;
  let mockBackupEncryption: Record<string, jest.Mock>;
  let mockSupportBackup: Record<string, jest.Mock>;

  const userId = "test-user-id";
  const mockReq = {
    user: { id: userId },
    body: Buffer.from("gzip-data"),
    headers: {},
  };

  beforeEach(async () => {
    mockBackupService = {
      streamExport: jest.fn().mockResolvedValue(undefined),
      restoreData: jest.fn(),
    };

    mockBackupEncryption = {
      getStatus: jest.fn(),
      setBackupPasswordForOidcUser: jest.fn(),
      enableWithLoginPassword: jest.fn(),
      disableForOidcUser: jest.fn(),
    };

    mockSupportBackup = {
      generate: jest.fn(),
      preview: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
        {
          provide: BackupEncryptionService,
          useValue: mockBackupEncryption,
        },
        {
          provide: SupportBackupService,
          useValue: mockSupportBackup,
        },
      ],
    }).compile();

    controller = module.get<BackupController>(BackupController);
  });

  describe("exportBackup", () => {
    it("should set response headers and delegate to streamExport", async () => {
      const mockRes = {
        setHeader: jest.fn(),
      };

      await controller.exportBackup(mockReq, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/gzip",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining(".json.gz"),
      );
      expect(mockBackupService.streamExport).toHaveBeenCalledWith(
        userId,
        mockRes,
        undefined,
      );
    });

    it("uses .mzbe filename and octet-stream content-type when encrypted", async () => {
      const mockRes = { setHeader: jest.fn() };
      const encryptedReq = {
        ...mockReq,
        headers: { "x-export-password": Buffer.from("pw").toString("base64") },
      };
      await controller.exportBackup(encryptedReq, mockRes as any);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/octet-stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining(".mzbe"),
      );
      expect(mockBackupService.streamExport).toHaveBeenCalledWith(
        userId,
        mockRes,
        "pw",
      );
    });

    /**
     * Node's base64 decoder silently discards characters outside the alphabet
     * instead of failing, so an unencoded (or wrongly encoded) header produced a
     * mangled password and no error. On export that is unrecoverable: the file is
     * encrypted under a password nobody knows, and the response says success.
     */
    it("refuses an export password header that is not base64", async () => {
      const mockRes = { setHeader: jest.fn() };
      const req = {
        ...mockReq,
        // A plausible mistake: the client sent the password as typed.
        headers: { "x-export-password": "my p@ssword!" },
      };

      await expect(
        controller.exportBackup(req, mockRes as any),
      ).rejects.toThrow(/base64/i);
      expect(mockBackupService.streamExport).not.toHaveBeenCalled();
    });

    it("accepts a correctly encoded password with padding and non-ASCII", async () => {
      const mockRes = { setHeader: jest.fn() };
      const password = "hasło  z odstępami ";
      const req = {
        ...mockReq,
        headers: {
          "x-export-password": Buffer.from(password, "utf8").toString("base64"),
        },
      };

      await controller.exportBackup(req, mockRes as any);

      // The whole reason for base64: surrounding whitespace and non-ASCII must
      // arrive exactly as typed.
      expect(mockBackupService.streamExport).toHaveBeenCalledWith(
        userId,
        mockRes,
        password,
      );
    });

    /**
     * CodeQL `js/polynomial-redos`.
     *
     * The padding was stripped with `/=+$/`, applied to the raw header. The
     * engine restarts the `=+` scan at every start position, so `"=".repeat(n)`
     * followed by one non-`=` character costs O(n^2) -- and the header is
     * attacker-supplied, unauthenticated at this point in the request, and
     * evaluated on the event loop, so a single request stalls every other one in
     * the process.
     *
     * A time budget rather than a shape assertion, because the defect was the
     * cost and not the syntax. 200k characters is ~4*10^10 backtracking steps
     * under the old expression -- minutes, well past any jest timeout -- against
     * a linear walk that finishes in single-digit milliseconds. The two-second
     * budget is three orders of magnitude clear of the fixed path, so this fails
     * on the regression without being a benchmark.
     */
    it.each(["x-export-password", "x-restore-password", "x-backup-password"])(
      "strips %s padding in linear time (ReDoS guard)",
      async (header) => {
        // Trailing non-`=` character: this is the shape that backtracks. A string
        // of pure `=` matches at the first position and never re-scans.
        const hostile = `${"=".repeat(200_000)}a`;
        const req = {
          ...mockReq,
          body: Buffer.from("gz"),
          headers: { [header]: hostile },
        };
        const mockRes = { setHeader: jest.fn() };

        const started = process.hrtime.bigint();
        // Every one of these headers is rejected -- `hostile` is not the base64
        // of its own decoding -- so the assertion is only about how fast.
        await expect(
          header === "x-export-password"
            ? controller.exportBackup(req, mockRes as any)
            : controller.restoreBackup(req),
        ).rejects.toThrow(/base64/i);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        expect(elapsedMs).toBeLessThan(2000);
      },
    );
  });

  describe("supportExport", () => {
    it("sends the generated buffer with a gzip filename", async () => {
      const mockRes = { setHeader: jest.fn(), send: jest.fn() };
      mockSupportBackup.generate.mockResolvedValue({
        buffer: Buffer.from("gz"),
        encrypted: false,
      });
      const dto = { multiplier: 2.5 };

      await controller.supportExport(mockReq, dto as any, mockRes as any);

      expect(mockSupportBackup.generate).toHaveBeenCalledWith(userId, dto);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/gzip",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining(".json.gz"),
      );
      expect(mockRes.send).toHaveBeenCalledWith(Buffer.from("gz"));
    });

    it("uses .mzbe when the file is encrypted", async () => {
      const mockRes = { setHeader: jest.fn(), send: jest.fn() };
      mockSupportBackup.generate.mockResolvedValue({
        buffer: Buffer.from("enc"),
        encrypted: true,
      });

      await controller.supportExport(
        mockReq,
        { multiplier: 2.5, password: "pw" } as any,
        mockRes as any,
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/octet-stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining(".mzbe"),
      );
    });

    it("preview delegates to the service", async () => {
      mockSupportBackup.preview.mockResolvedValue({ samples: [] });
      const dto = { multiplier: 2.5 };

      const result = await controller.supportExportPreview(mockReq, dto as any);

      expect(mockSupportBackup.preview).toHaveBeenCalledWith(userId, dto);
      expect(result).toEqual({ samples: [] });
    });
  });

  describe("password header decoding on restore", () => {
    it("refuses a restore password header that is not base64", async () => {
      const req = {
        user: { id: userId },
        body: Buffer.from("gz"),
        headers: { "x-restore-password": "not base64!" },
      };

      await expect(controller.restoreBackup(req)).rejects.toThrow(/base64/i);
      // A mangled password here is a confusing 401 rather than data loss, but
      // the request must still be refused rather than guessed at.
      expect(mockBackupService.restoreData).not.toHaveBeenCalled();
    });
  });

  describe("mintRestoreUploadTicket", () => {
    const secret = "a-jwt-secret-of-at-least-32-characters!!";
    let previous: string | undefined;

    beforeEach(() => {
      previous = process.env.JWT_SECRET;
      process.env.JWT_SECRET = secret;
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    });

    /**
     * DR-F3RB-003: this route exists so authorization can happen before the
     * upload's memory is reserved, which is before any Nest guard runs. So the
     * ticket it hands out has to be one the middleware actually accepts -- an
     * assertion on the shape of the response would pass on a ticket nothing can
     * verify.
     */
    it("mints a ticket the admission authorizer accepts", () => {
      const result = controller.mintRestoreUploadTicket({
        user: { id: userId },
      });
      expect(result.header).toBe(RESTORE_TICKET_HEADER);
      expect(result.expiresInSeconds).toBeGreaterThan(0);

      const authorize = createRestoreTicketAuthorizer(secret);
      expect(
        authorize({
          headers: { [RESTORE_TICKET_HEADER]: result.ticket },
        } as never),
      ).toEqual({ ok: true });
    });

    it("mints for the caller, not for whoever asks about them", () => {
      const mine = controller.mintRestoreUploadTicket({ user: { id: userId } });
      const theirs = controller.mintRestoreUploadTicket({
        user: { id: "another-user" },
      });
      expect(mine.ticket).not.toBe(theirs.ticket);
      expect(verifyRestoreUploadTicket(mine.ticket, secret)).toMatchObject({
        ok: true,
        payload: { userId },
      });
    });

    it("refuses rather than signing with nothing", () => {
      delete process.env.JWT_SECRET;
      // A ticket signed with an empty key is forgeable by anyone, so an
      // unverifiable deployment must refuse. Startup already blocks this state;
      // the route does not rely on that being true.
      expect(() =>
        controller.mintRestoreUploadTicket({ user: { id: userId } }),
      ).toThrow(ServiceUnavailableException);
    });
  });

  describe("restoreBackup", () => {
    it("should pass compressed body and auth headers to service", async () => {
      const mockResult = {
        message: "Backup restored successfully",
        restored: { categories: 5 },
      };
      mockBackupService.restoreData.mockResolvedValue(mockResult);

      const req = {
        user: { id: userId },
        body: Buffer.from("gzip-data"),
        headers: {
          "x-restore-password": Buffer.from("mypassword").toString("base64"),
        },
      };

      const result = await controller.restoreBackup(req);

      expect(mockBackupService.restoreData).toHaveBeenCalledWith(userId, {
        compressedData: req.body,
        password: "mypassword",
        oidcIdToken: undefined,
        backupPassword: undefined,
        // Bounds the wait for a processing slot only (DR-F3RB-002); the tests
        // below pin what it does and does not cancel.
        queueAbortSignal: expect.any(AbortSignal),
      });
      expect(result).toEqual(mockResult);
    });

    it("should pass OIDC token header to service", async () => {
      mockBackupService.restoreData.mockResolvedValue({
        message: "ok",
        restored: {},
      });

      const req = {
        user: { id: userId },
        body: Buffer.from("gzip-data"),
        headers: {
          "x-restore-oidc-token": "oidc-token-value",
        },
      };

      await controller.restoreBackup(req);

      expect(mockBackupService.restoreData).toHaveBeenCalledWith(userId, {
        compressedData: req.body,
        password: undefined,
        oidcIdToken: "oidc-token-value",
        backupPassword: undefined,
        queueAbortSignal: expect.any(AbortSignal),
      });
    });

    /**
     * DR-F3RB-002 at the controller: the signal the gate waits on has to come
     * from somewhere, and the only thing that knows the caller left is the
     * response socket. `close` before the response finished is that fact.
     */
    it("aborts the queue wait when the caller disconnects", async () => {
      let captured: AbortSignal | undefined;
      mockBackupService.restoreData.mockImplementation(
        (_userId: string, input: { queueAbortSignal?: AbortSignal }) => {
          captured = input.queueAbortSignal;
          return Promise.resolve({ message: "ok", restored: {} });
        },
      );
      const listeners: Array<() => void> = [];
      const res = {
        writableEnded: false,
        headersSent: false,
        once: (event: string, listener: () => void) => {
          if (event === "close") listeners.push(listener);
        },
        removeListener: () => undefined,
      };

      await controller.restoreBackup({
        user: { id: userId },
        body: Buffer.from("data"),
        headers: {},
        res,
      });

      expect(captured?.aborted).toBe(false);
      for (const listener of listeners) listener();
      expect(captured?.aborted).toBe(true);
    });

    /**
     * A response that finished is not a caller who left. Firing the signal on
     * every `close` would abort the wait of the next restore queued behind a
     * request that completed normally.
     */
    it("does not abort when the response completed", async () => {
      let captured: AbortSignal | undefined;
      mockBackupService.restoreData.mockImplementation(
        (_userId: string, input: { queueAbortSignal?: AbortSignal }) => {
          captured = input.queueAbortSignal;
          return Promise.resolve({ message: "ok", restored: {} });
        },
      );
      const listeners: Array<() => void> = [];
      const res = {
        writableEnded: true,
        headersSent: false,
        once: (event: string, listener: () => void) => {
          if (event === "close") listeners.push(listener);
        },
        removeListener: () => undefined,
      };

      await controller.restoreBackup({
        user: { id: userId },
        body: Buffer.from("data"),
        headers: {},
        res,
      });

      for (const listener of listeners) listener();
      expect(captured?.aborted).toBe(false);
    });

    /**
     * The two 503s on this route differ by one header, and a Nest exception
     * cannot set one -- so the controller does, for the transient case only.
     * Without this the client cannot tell a full queue from a deployment that
     * will refuse every restore until an operator changes it.
     */
    it("sets Retry-After on a transient refusal and not on a permanent one", async () => {
      const headers: Record<string, string> = {};
      const res = {
        writableEnded: false,
        headersSent: false,
        once: () => undefined,
        removeListener: () => undefined,
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      };
      const request = {
        user: { id: userId },
        body: Buffer.from("data"),
        headers: {},
        res,
      };

      mockBackupService.restoreData.mockRejectedValue(
        new RestoreQueueBusyException("busy"),
      );
      await expect(controller.restoreBackup(request)).rejects.toBeInstanceOf(
        RestoreQueueBusyException,
      );
      expect(headers["Retry-After"]).toBe(String(RESTORE_RETRY_AFTER_SECONDS));

      delete headers["Retry-After"];
      mockBackupService.restoreData.mockRejectedValue(
        new ServiceUnavailableException("no headroom"),
      );
      await expect(controller.restoreBackup(request)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(headers["Retry-After"]).toBeUndefined();
    });

    it("should throw BadRequestException if body is not a buffer", async () => {
      const req = {
        user: { id: userId },
        body: "not-a-buffer",
        headers: {},
      };

      await expect(controller.restoreBackup(req)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException if body is empty buffer", async () => {
      const req = {
        user: { id: userId },
        body: Buffer.alloc(0),
        headers: {},
      };

      await expect(controller.restoreBackup(req)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("passes through the backup password header", async () => {
      mockBackupService.restoreData.mockResolvedValue({
        message: "ok",
        restored: {},
      });
      const req = {
        user: { id: userId },
        body: Buffer.from("data"),
        headers: {
          "x-backup-password": Buffer.from("old-password").toString("base64"),
        },
      };
      await controller.restoreBackup(req);
      expect(mockBackupService.restoreData).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ backupPassword: "old-password" }),
      );
    });

    it("decodes a restore password that begins with a space", async () => {
      mockBackupService.restoreData.mockResolvedValue({
        message: "ok",
        restored: {},
      });
      const req = {
        user: { id: userId },
        body: Buffer.from("data"),
        headers: {
          "x-restore-password":
            Buffer.from(" leading space").toString("base64"),
        },
      };
      await controller.restoreBackup(req);
      expect(mockBackupService.restoreData).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ password: " leading space" }),
      );
    });
  });

  describe("encryption endpoints", () => {
    it("getEncryptionStatus delegates to the encryption service", async () => {
      mockBackupEncryption.getStatus.mockResolvedValue({
        enabled: true,
        manageable: false,
      });
      const result = await controller.getEncryptionStatus({
        user: { id: userId },
      });
      expect(mockBackupEncryption.getStatus).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ enabled: true, manageable: false });
    });

    it("setBackupPassword delegates with the new password", async () => {
      await controller.setBackupPassword(
        { user: { id: userId } },
        { backupPassword: "long-good-password" },
      );
      expect(
        mockBackupEncryption.setBackupPasswordForOidcUser,
      ).toHaveBeenCalledWith(userId, "long-good-password");
    });

    it("enableWithLoginPassword delegates the confirmed login password", async () => {
      const result = await controller.enableWithLoginPassword(
        { user: { id: userId } },
        { loginPassword: "hunter2hunter2" },
      );
      // The caller's own id, never one from the body: this endpoint verifies a
      // password against an account's hash.
      expect(mockBackupEncryption.enableWithLoginPassword).toHaveBeenCalledWith(
        userId,
        "hunter2hunter2",
      );
      expect(result).toEqual({ enabled: true });
    });

    it("disableEncryption delegates", async () => {
      await controller.disableEncryption({ user: { id: userId } });
      expect(mockBackupEncryption.disableForOidcUser).toHaveBeenCalledWith(
        userId,
      );
    });
  });
});
