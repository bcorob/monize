import { createHash } from "crypto";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { stripControlCharacters } from "../imap/strip-control-characters";
import { EmailReceiptMailboxService } from "../mailbox/email-receipt-mailbox.service";
import {
  resolveEmailReceiptPollLimits,
  type EmailReceiptPollLimits,
} from "../poll/email-receipt-poll-limits";
import { EmailReceiptPollService } from "../poll/email-receipt-poll.service";
import { loadOwnAddresses, ownAddressesOnce } from "../poll/own-addresses";
import {
  buildReceiptRow,
  insertReceiptRows,
  skippedRow,
  type ReceiptRow,
} from "../poll/receipt-rows";
import {
  detectArchiveFormat,
  splitMbox,
  type ArchiveFormat,
  type ArchiveFormatError,
} from "./mbox";
import { readMsgAsRfc822 } from "./msg-message";
import {
  newZipBudget,
  readZip,
  type ZipBudget,
  type ZipEntryKind,
  type ZipError,
} from "./zip-archive";

/**
 * The `uid_validity` of every imported row. IMAP's UIDVALIDITY is a `nz-number`
 * (RFC 9051): a server never reports 0, so an imported row cannot collide with
 * a polled one under `UNIQUE (mailbox_id, uid_validity, uid)`.
 */
export const IMPORTED_UID_VALIDITY = "0";
/** Messages read per request, across all files. */
export const MAX_IMPORT_MESSAGES = 5_000;
const MAX_NAME_CHARS = 255;
const UID_MASK = (1n << 63n) - 1n;

export interface EmailReceiptImportFileResult {
  name: string;
  format: ArchiveFormat | null;
  messages: number;
  stored: number;
  duplicates: number;
  skipped: number;
  /** Zip entries that are not mail files (folders, other types, nested zips). */
  ignoredEntries: number;
  error: ImportFileError | null;
}

export type ImportFileError = ArchiveFormatError | ZipError | "empty";

export interface EmailReceiptImportResult {
  files: EmailReceiptImportFileResult[];
  truncated: number;
  processed: number;
  busy: boolean;
}

export interface ImportFileInput {
  originalname: string;
  buffer: Buffer;
}

/** One message found in a file, before its row is built. */
interface CandidateMessage {
  /** `msg` is rebuilt as RFC 5322 first. */
  kind: "rfc822" | "msg";
  /** Null for a zip entry above the message limit: only its hash was kept. */
  source: Buffer | null;
  rawSha256: string | null;
  fallbackDate: Date;
}

/** What is left of the per-request caps while the files are read. */
interface RequestState {
  remainingMessages: number;
  truncated: number;
  zipBudget: ZipBudget;
}

interface FileCandidates {
  candidates: CandidateMessage[];
  ignoredEntries: number;
  error: ImportFileError | null;
}

/**
 * The stored `uid` of an imported message: the first 63 bits of SHA-256 of
 * `mid:<Message-ID, lower-case>` when it has a Message-ID, else of
 * `raw:<SHA-256 of its bytes>`. Positive and below 2^63, so it fits `bigint`.
 */
export function deriveImportedUid(
  messageId: string | null,
  source: Buffer,
): string {
  const id = messageId?.trim().toLowerCase();
  return id
    ? uidOfKey(`mid:${id}`)
    : deriveRawUid(createHash("sha256").update(source).digest("hex"));
}

/** The uid of a message identified by the SHA-256 (hex) of its bytes. */
export function deriveRawUid(sha256Hex: string): string {
  return uidOfKey(`raw:${sha256Hex}`);
}

function uidOfKey(key: string): string {
  const digest = createHash("sha256").update(key).digest();
  return (digest.readBigUInt64BE(0) & UID_MASK).toString();
}

function safeName(name: string): string {
  return stripControlCharacters(name)
    .replace(/[\n\t]/g, " ")
    .slice(0, MAX_NAME_CHARS);
}

/**
 * The archive import: the
 * messages of uploaded `.eml`, `.mbox`, `.msg` and `.zip` files are stored as rows of the
 * person's own mailbox through the poll's row builder and insert, under
 * `uid_validity` 0, then the stored-email part of a poll runs under the poll
 * lease. Nothing is written outside PostgreSQL. What stops a message being
 * stored twice is `ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING`
 * (INV-RECEIPT-002), one transaction per file.
 */
@Injectable()
export class EmailReceiptImportService {
  private readonly logger = new Logger(EmailReceiptImportService.name);
  private readonly limits: EmailReceiptPollLimits =
    resolveEmailReceiptPollLimits(process.env, this.logger);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailbox: EmailReceiptMailboxService,
    private readonly poll: EmailReceiptPollService,
  ) {}

  async importFiles(
    userId: string,
    files: readonly ImportFileInput[],
    options: { process?: boolean } = {},
  ): Promise<EmailReceiptImportResult> {
    const view = await this.mailbox.getView(userId);
    if (!view) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.mailboxNotFound",
          "No mailbox is set up for this account.",
        ),
      );
    }
    const now = new Date();
    const ownAddresses = ownAddressesOnce(() =>
      withScopedDb(this.dataSource, (m) => loadOwnAddresses(m, userId)),
    );
    const state: RequestState = {
      remainingMessages: MAX_IMPORT_MESSAGES,
      truncated: 0,
      zipBudget: newZipBudget(),
    };
    const results: EmailReceiptImportFileResult[] = [];
    for (const file of files) {
      const name = safeName(file.originalname);
      const format = detectArchiveFormat(file.originalname, file.buffer);
      if (typeof format === "object") {
        results.push(this.refused(name, format.error));
        continue;
      }
      const found = this.collect(format, file.buffer, state, now);
      const rows: ReceiptRow[] = [];
      for (const candidate of found.candidates) {
        rows.push(await this.toRow(candidate, now, ownAddresses));
      }
      const counts = await withScopedDb(this.dataSource, (m) =>
        insertReceiptRows(m, userId, view.id, IMPORTED_UID_VALIDITY, rows),
      );
      results.push({
        name,
        format,
        messages: rows.length,
        ...counts,
        ignoredEntries: found.ignoredEntries,
        error:
          found.error ??
          (rows.length === 0 && found.ignoredEntries === 0 ? "empty" : null),
      });
    }
    // `process: false`: the caller (the browser, after the last part of an
    // archive) processes the stored rows itself, so one request never counts
    // or processes rows of another request or of the rest of the mailbox.
    const { processed, busy } =
      options.process === false
        ? { processed: 0, busy: false }
        : await this.poll.processStoredNow(userId);
    return { files: results, truncated: state.truncated, processed, busy };
  }

  private refused(
    name: string,
    error: ArchiveFormatError,
  ): EmailReceiptImportFileResult {
    return {
      name,
      format: null,
      messages: 0,
      stored: 0,
      duplicates: 0,
      skipped: 0,
      ignoredEntries: 0,
      error,
    };
  }

  private collect(
    format: ArchiveFormat,
    bytes: Buffer,
    state: RequestState,
    now: Date,
  ): FileCandidates {
    const candidates: CandidateMessage[] = [];
    if (format === "zip") {
      const read = readZip(bytes, state.zipBudget, this.limits.maxMessageBytes);
      for (const entry of read.entries) {
        this.collectEntry(
          entry.kind,
          entry.bytes,
          entry.rawSha256,
          candidates,
          state,
          now,
        );
      }
      return {
        candidates,
        ignoredEntries: read.ignored,
        error: read.error,
      };
    }
    this.collectEntry(format, bytes, null, candidates, state, now);
    return { candidates, ignoredEntries: 0, error: null };
  }

  /** Add the messages of one `.eml`, `.mbox` or `.msg` within the request's cap. */
  private collectEntry(
    kind: ZipEntryKind,
    bytes: Buffer | null,
    rawSha256: string | null,
    into: CandidateMessage[],
    state: RequestState,
    now: Date,
  ): void {
    if (kind === "mbox" && bytes !== null) {
      const split = splitMbox(bytes, state.remainingMessages);
      for (const message of split.messages) {
        into.push({
          kind: "rfc822",
          source: message.source,
          rawSha256: null,
          fallbackDate: message.separatorDate ?? now,
        });
      }
      state.remainingMessages -= split.messages.length;
      state.truncated += split.truncated;
      return;
    }
    if (state.remainingMessages <= 0) {
      state.truncated += 1;
      return;
    }
    state.remainingMessages -= 1;
    into.push({
      kind: kind === "msg" ? "msg" : "rfc822",
      source: bytes,
      rawSha256,
      fallbackDate: now,
    });
  }

  private async toRow(
    candidate: CandidateMessage,
    now: Date,
    ownAddresses: () => Promise<ReadonlySet<string>>,
  ): Promise<ReceiptRow> {
    const { source, fallbackDate } = candidate;
    // A message above the poll's cap is not parsed: its identity is consumed
    // and it is stored `skipped`, as a polled one is.
    if (source === null) {
      return skippedRow(
        deriveRawUid(candidate.rawSha256 ?? ""),
        "too_large",
        fallbackDate,
      );
    }
    if (source.length > this.limits.maxMessageBytes) {
      return skippedRow(
        deriveImportedUid(null, source),
        "too_large",
        fallbackDate,
      );
    }
    const mime = candidate.kind === "msg" ? readMsgAsRfc822(source) : source;
    if (mime === null) {
      return skippedRow(
        deriveImportedUid(null, source),
        "undecodable",
        fallbackDate,
      );
    }
    const row = await buildReceiptRow(
      mime,
      "0",
      fallbackDate,
      now,
      ownAddresses,
    );
    return { ...row, uid: deriveImportedUid(row.messageId, source) };
  }
}
