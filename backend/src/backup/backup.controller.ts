import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  UseGuards,
  Request,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { Response } from "express";
import { BackupService } from "./backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";
import { CreateSupportBackupDto } from "./support-backup/dto/create-support-backup.dto";
import { Throttle } from "@nestjs/throttler";
import { rateLimit } from "../common/throttle.util";
import {
  ConfirmLoginPasswordDto,
  SetBackupPasswordDto,
} from "./dto/backup-encryption.dto";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { tr } from "../i18n/translate";
import { releaseRestoreReservation } from "./restore-upload-admission";
import {
  CLIENT_CLOSED_REQUEST,
  RestoreQueueBusyException,
} from "./restore-processing-gate";
import {
  RESTORE_TICKET_HEADER,
  mintRestoreUploadTicket,
} from "./restore-upload-ticket";

/**
 * Drop trailing `=` padding without a regular expression.
 *
 * `/=+$/` over an attacker-supplied header is a polynomial ReDoS
 * (CodeQL `js/polynomial-redos`): the engine restarts the `=+` scan at every
 * position, so a header of n `=` characters costs O(n^2). A single backwards
 * walk is O(n) and answers the same question.
 */
function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x3d /* '=' */) {
    end -= 1;
  }
  return value.slice(0, end);
}

// Password header values are base64-encoded by the client so leading/trailing
// whitespace (and non-ASCII characters) survive HTTP header transport, which
// otherwise strips surrounding whitespace per RFC 7230. Decode them back to the
// exact password the user typed before any credential comparison or decryption.
//
// The round-trip check is the point. Node's base64 decoder is lenient: it
// silently discards characters outside the alphabet rather than failing, so a
// client that sent the password unencoded (or encoded it wrongly) got a mangled
// string back and no error anywhere. On `x-restore-password` that is a
// confusing 401; on `x-export-password` it is unrecoverable, because the export
// is then encrypted under a password nobody knows and reported as a success.
// Better to refuse the request than to hand back a file that can never be
// opened.
function decodePasswordHeader(
  value: string | undefined,
  header: string,
): string | undefined {
  if (value === undefined) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (
    stripBase64Padding(decoded.toString("base64")) !== stripBase64Padding(value)
  ) {
    throw new BadRequestException(
      tr(
        "errors.backup.passwordHeaderNotBase64",
        `The ${header} header must be base64-encoded.`,
        { header },
      ),
    );
  }
  return decoded.toString("utf8");
}

/**
 * Manual export, restore and backup encryption -- everything here acts on the
 * caller's own data and is open to every signed-in user. Automatic backup
 * configuration is an operator concern and lives on the admin-only
 * `AutoBackupController`.
 */
@ApiTags("Backup")
@Controller("backup")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly backupEncryption: BackupEncryptionService,
    private readonly supportBackupService: SupportBackupService,
  ) {}

  /** Download headers shared by the plain and support export endpoints, so
   *  the filename/content-type convention lives in one place. */
  private setBackupDownloadHeaders(
    res: Response,
    encrypted: boolean,
    prefix: string,
  ): void {
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${prefix}-${today}.${encrypted ? "mzbe" : "json.gz"}`;
    res.setHeader(
      "Content-Type",
      encrypted ? "application/octet-stream" : "application/gzip",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  }

  @Post("export")
  @DemoRestricted()
  @ApiOperation({ summary: "Export all user data as JSON backup" })
  @ApiResponse({ status: 200, description: "Backup file downloaded" })
  async exportBackup(@Request() req, @Res() res: Response) {
    // Encryption password (when encryption is enabled) comes via header so the
    // browser can issue a plain GET-like POST without a body parser dependency
    // and so it never lands in server access logs as a query string.
    const encryptionPassword = decodePasswordHeader(
      req.headers["x-export-password"] as string | undefined,
      "x-export-password",
    );

    this.setBackupDownloadHeaders(res, !!encryptionPassword, "monize-backup");
    await this.backupService.streamExport(req.user.id, res, encryptionPassword);
  }

  @Post("support-export")
  @DemoRestricted()
  @ApiOperation({
    summary:
      "Export a de-identified backup for sharing with support (masked text, scaled amounts)",
  })
  @ApiResponse({ status: 200, description: "De-identified backup downloaded" })
  async supportExport(
    @Request() req,
    @Body() dto: CreateSupportBackupDto,
    @Res() res: Response,
  ) {
    const { buffer, encrypted } = await this.supportBackupService.generate(
      req.user.id,
      dto,
    );
    this.setBackupDownloadHeaders(res, encrypted, "monize-support-backup");
    res.send(buffer);
  }

  @Post("support-export/preview")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Preview the de-identified backup: before/after samples of key tables",
  })
  @ApiResponse({ status: 200, description: "Preview samples returned" })
  async supportExportPreview(
    @Request() req,
    @Body() dto: CreateSupportBackupDto,
  ) {
    return this.supportBackupService.preview(req.user.id, dto);
  }

  @Post("restore/ticket")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mint a short-lived ticket authorizing one restore upload",
    description:
      "The restore upload's memory admission has to run in front of the body parser, which is in front of every Nest guard -- so it cannot authenticate the request it is budgeting for (DR-F3RB-003). This route can: it is ordinary authenticated JSON, and it hands back a signed ticket the admission middleware verifies before reserving anything. Without one, an upload is refused 403 having claimed no memory -- 403 rather than 401 because the session is fine and it is this request that carries no authorization, and because a client reads a 401 as an expired session and retries the whole upload.",
  })
  @ApiResponse({ status: 200, description: "Ticket minted" })
  mintRestoreUploadTicket(@Request() req) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // Startup refuses to run without it, so this is unreachable in a live
      // deployment -- but a ticket signed with an empty key would be forgeable by
      // anyone, so the failure has to be loud rather than convenient.
      throw new ServiceUnavailableException(
        tr(
          "errors.backup.restoreTicketUnavailable",
          "This deployment cannot authorize restore uploads.",
        ),
      );
    }
    const { ticket, expiresInSeconds } = mintRestoreUploadTicket(
      req.user.id,
      secret,
    );
    return { ticket, expiresInSeconds, header: RESTORE_TICKET_HEADER };
  }

  @Post("restore")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Restore user data from a backup file (gzipped JSON or encrypted Monize backup)",
  })
  @ApiResponse({ status: 200, description: "Data restored successfully" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  @ApiResponse({
    status: 400,
    description:
      "Invalid backup format, a decompression or JSON failure, or a decompressed payload over BACKUP_RESTORE_EXPANDED_LIMIT -- the expanded ceiling answers 400, not 413, because by then the request body was within its own limit",
  })
  @ApiResponse({
    status: 413,
    description:
      "Compressed upload exceeds BACKUP_RESTORE_LIMIT. A request declaring an oversized Content-Length is refused before its body is read; without a usable one -- absent header, chunked transfer, or a declared length under what is actually sent -- express.raw enforces the same limit while receiving, so the refusal arrives mid-transfer instead",
  })
  @ApiResponse({
    status: 408,
    description:
      "Upload did not arrive within the receive deadline; its memory reservation was released",
  })
  @ApiResponse({
    status: 503,
    description:
      "Four conditions, and the header separates them into two kinds. Transient, carrying Retry-After: the aggregate upload budget is occupied; the processing queue is full (BACKUP_RESTORE_QUEUE_LIMIT); or the wait for a processing slot exceeded BACKUP_RESTORE_QUEUE_WAIT_MS. Persistent, carrying no Retry-After: modeled processing capacity is zero, which lasts until an operator raises the container memory or lowers BACKUP_RESTORE_EXPANDED_LIMIT. Contention for a slot while capacity is positive queues, up to the queue limit, rather than answering 503 immediately.",
  })
  @ApiResponse({
    status: CLIENT_CLOSED_REQUEST,
    description:
      "The caller disconnected while queued for a processing slot, so the restore was never started. Nothing reads this response by construction; it exists so the access log distinguishes an abandoned wait from a fault. A disconnect after the slot is granted does NOT cancel the restore.",
  })
  async restoreBackup(@Request() req) {
    const body: unknown = req.body;
    // CodeQL js/type-confusion-through-parameter-tampering doesn't model
    // Buffer.isBuffer as a type guard. Explicit typeof / Array.isArray
    // narrowing rejects the string and array forms body-parser can produce.
    if (
      typeof body === "string" ||
      Array.isArray(body) ||
      !Buffer.isBuffer(body) ||
      body.length === 0
    ) {
      throw new BadRequestException(
        tr(
          "errors.backup.restoreBodyMustBeFile",
          "Request body must be a backup file",
        ),
      );
    }

    const password = decodePasswordHeader(
      req.headers["x-restore-password"] as string | undefined,
      "x-restore-password",
    );
    const oidcIdToken = req.headers["x-restore-oidc-token"] as
      | string
      | undefined;
    const backupPassword = decodePasswordHeader(
      req.headers["x-backup-password"] as string | undefined,
      "x-backup-password",
    );

    // A restore that has to wait for a processing slot should not still run if
    // the caller has hung up in the meantime -- the operation is destructive, and
    // nobody is left to see its result (DR-F3RB-002). The signal bounds the wait
    // only: `RestoreProcessingGate` unsubscribes when it grants the slot, so a
    // disconnect during the restore itself changes nothing.
    const response = req.res as Response | undefined;
    const abandoned = new AbortController();
    const onClose = () => {
      if (response && !response.writableEnded) abandoned.abort();
    };
    response?.once("close", onClose);

    try {
      return await this.backupService.restoreData(req.user.id, {
        compressedData: body,
        password,
        oidcIdToken,
        backupPassword,
        queueAbortSignal: abandoned.signal,
      });
    } catch (error) {
      // A Nest exception cannot set a header, and the difference between the two
      // 503s on this route is exactly that header: this one is worth retrying,
      // zero modeled capacity is not.
      if (
        error instanceof RestoreQueueBusyException &&
        response &&
        !response.headersSent
      ) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    } finally {
      response?.removeListener("close", onClose);
      // The upload's memory reservation is held from before the body was parsed
      // (see `createRestoreUploadAdmission`) and only the handler knows when the
      // expensive work is over. Releasing on the response socket closing instead
      // freed it while decryption, staging and SQL were still running, so a
      // second large upload could be admitted beside this one.
      releaseRestoreReservation(req);
    }
  }

  @Get("encryption")
  @ApiOperation({ summary: "Get backup encryption status for current user" })
  @ApiResponse({ status: 200, description: "Encryption status returned" })
  async getEncryptionStatus(@Request() req) {
    return this.backupEncryption.getStatus(req.user.id);
  }

  @Post("encryption/login-password")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  // A password check, so it is throttled like one. Same window and count as the
  // auth controller's credential endpoints: this verifies `password_hash`, and
  // an unthrottled verifier is an oracle whatever screen it is reached from.
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiOperation({
    summary:
      "Turn on encrypted backups for a local account by confirming its login password",
  })
  @ApiResponse({ status: 200, description: "Encryption enabled" })
  async enableWithLoginPassword(
    @Request() req,
    @Body() dto: ConfirmLoginPasswordDto,
  ) {
    await this.backupEncryption.enableWithLoginPassword(
      req.user.id,
      dto.loginPassword,
    );
    return { enabled: true };
  }

  @Post("encryption/backup-password")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set or update the dedicated backup password (OIDC users only; local users' backups are encrypted with their login password automatically)",
  })
  @ApiResponse({ status: 200, description: "Backup password set" })
  async setBackupPassword(@Request() req, @Body() dto: SetBackupPasswordDto) {
    await this.backupEncryption.setBackupPasswordForOidcUser(
      req.user.id,
      dto.backupPassword,
    );
    return { enabled: true };
  }

  @Delete("encryption")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable encrypted backups (OIDC users only)" })
  @ApiResponse({ status: 200, description: "Encryption disabled" })
  async disableEncryption(@Request() req) {
    await this.backupEncryption.disableForOidcUser(req.user.id);
    return { enabled: false };
  }
}
