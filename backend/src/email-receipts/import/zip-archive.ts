import { createHash } from "crypto";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

/**
 * Reads the mail files out of an uploaded `.zip` (archive-import decision 4,
 * recorded in `backend/src/email-receipts/import/email-receipt-import.service.ts`). Nothing is written to disk and an
 * entry name is used only to choose the format, so a path in a name reaches
 * nothing.
 *
 * The ceiling counts the bytes the inflater PRODUCES, never the size the archive
 * declares: the archive is fed to fflate's streaming `Unzip` in small slices and
 * every output chunk is added to the request's budget before it is kept, so a
 * header that lies about its size cannot expand past it. The slice size bounds
 * how far one push can overshoot (deflate's best ratio is about 1000:1).
 */

/** Most entries (files and folders) one archive may hold. */
export const MAX_ZIP_ENTRIES = 2_000;
/** Most bytes all archives of one request may expand to. */
export const MAX_ZIP_REQUEST_BYTES = 100 * 1024 * 1024;
/** Largest mbox entry. */
export const MAX_ZIP_MBOX_ENTRY_BYTES = 100 * 1024 * 1024;
/** Compressed bytes handed to the inflater per push. */
const PUSH_SLICE_BYTES = 16 * 1024;
const STORED = 0;
const DEFLATED = 8;
const FROM_SPACE = "From ";
const EMPTY_ARCHIVE_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export type ZipEntryKind = "eml" | "mbox" | "msg";
export type ZipError = "invalid_archive" | "archive_too_large";

export interface ZipEntry {
  kind: ZipEntryKind;
  /**
   * The entry's bytes, or null for an `.eml` / `.msg` entry above the message
   * limit (it is not kept: `rawSha256` identifies it).
   */
  bytes: Buffer | null;
  size: number;
  /** SHA-256 (hex) of the whole entry, set only when `bytes` is null. */
  rawSha256: string | null;
}

export interface ZipRead {
  /** Entries read in full before any error. */
  entries: ZipEntry[];
  /** Entries that are not mail files (folders, other types, nested zips). */
  ignored: number;
  error: ZipError | null;
}

/** The bytes still allowed for the whole request; shared by every zip in it. */
export interface ZipBudget {
  remainingBytes: number;
}

export function newZipBudget(): ZipBudget {
  return { remainingBytes: MAX_ZIP_REQUEST_BYTES };
}

/** Thrown to stop the inflater; the reason is kept by `readZip`, not read from this. */
class Aborted extends Error {}

type EntryClass = ZipEntryKind | "mbox_if_from" | null;

function classify(name: string): EntryClass {
  const lower = name.toLowerCase();
  if (lower.endsWith("/") || lower.endsWith("\\")) return null;
  if (lower.startsWith("__macosx/")) return null;
  const base = lower.slice(
    Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1,
  );
  if (base.startsWith("._")) return null;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "mbox_if_from";
  switch (base.slice(dot)) {
    case ".eml":
      return "eml";
    case ".mbox":
    case ".mbx":
      return "mbox";
    case ".msg":
      return "msg";
    default:
      return null;
  }
}

interface OpenEntry {
  kind: ZipEntryKind | "mbox_if_from";
  chunks: Buffer[];
  size: number;
  hash: ReturnType<typeof createHash> | null;
  dropped: boolean;
}

function startsWithFrom(chunks: readonly Buffer[]): boolean {
  return Buffer.concat(chunks).toString("latin1", 0, 5) === FROM_SPACE;
}

/**
 * @param maxMessageBytes the largest `.eml` / `.msg` entry kept; a larger one is
 *   returned without its bytes, for a `too_large` row.
 */
export function readZip(
  archive: Buffer,
  budget: ZipBudget,
  maxMessageBytes: number,
): ZipRead {
  const entries: ZipEntry[] = [];
  let ignored = 0;
  let entryCount = 0;
  let open = 0;

  // fflate hands an error thrown inside `ondata` back to `ondata` as its `error`
  // argument, so the first reason is recorded here and never overwritten.
  let failure: ZipError | null = null;
  const fail = (reason: ZipError): never => {
    failure ??= reason;
    throw new Aborted();
  };
  const account = (length: number): void => {
    budget.remainingBytes -= length;
    if (budget.remainingBytes < 0) fail("archive_too_large");
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) fail("archive_too_large");
    const entryClass = classify(file.name);
    const readable =
      file.compression === STORED || file.compression === DEFLATED;
    if (entryClass === null || !readable) {
      ignored++;
      // Not started: if the archive does not declare its size, fflate still
      // inflates it to find the end, and that output counts too.
      file.ondata = (error, chunk) => {
        if (error) fail("invalid_archive");
        account(chunk.length);
      };
      return;
    }
    const entry: OpenEntry = {
      kind: entryClass,
      chunks: [],
      size: 0,
      hash: null,
      dropped: false,
    };
    open++;
    file.ondata = (error, chunk, final) => {
      if (error) fail("invalid_archive");
      account(chunk.length);
      entry.size += chunk.length;
      if (entry.kind === "mbox" || entry.kind === "mbox_if_from") {
        if (entry.size > MAX_ZIP_MBOX_ENTRY_BYTES) fail("archive_too_large");
      }
      if (!entry.dropped) {
        if (entry.hash) {
          entry.hash.update(chunk);
        } else {
          entry.chunks.push(Buffer.from(chunk));
          if (
            entry.kind !== "mbox" &&
            entry.kind !== "mbox_if_from" &&
            entry.size > maxMessageBytes
          ) {
            entry.hash = createHash("sha256");
            for (const kept of entry.chunks) entry.hash.update(kept);
            entry.chunks = [];
          }
        }
      }
      if (entry.kind === "mbox_if_from" && !entry.dropped) {
        if (entry.size >= FROM_SPACE.length || final) {
          if (!startsWithFrom(entry.chunks)) {
            entry.dropped = true;
            entry.chunks = [];
          }
        }
      }
      if (!final) return;
      open--;
      if (entry.dropped) {
        ignored++;
        return;
      }
      if (entry.kind === "mbox_if_from" || entry.kind === "mbox") {
        entries.push({
          kind: "mbox",
          bytes: Buffer.concat(entry.chunks),
          size: entry.size,
          rawSha256: null,
        });
      } else if (entry.hash) {
        entries.push({
          kind: entry.kind,
          bytes: null,
          size: entry.size,
          rawSha256: entry.hash.digest("hex"),
        });
      } else {
        entries.push({
          kind: entry.kind,
          bytes: Buffer.concat(entry.chunks),
          size: entry.size,
          rawSha256: null,
        });
      }
    };
    file.start();
  };

  let error: ZipError | null = null;
  try {
    for (let at = 0; at < archive.length; at += PUSH_SLICE_BYTES) {
      const end = Math.min(at + PUSH_SLICE_BYTES, archive.length);
      unzip.push(archive.subarray(at, end), end >= archive.length);
    }
    if (open > 0) error = "invalid_archive";
  } catch {
    error = failure ?? "invalid_archive";
  }
  if (error === null && entryCount === 0) {
    // An archive with no entry at all: an empty one is only its end record.
    const isEmptyArchive =
      archive.length >= EMPTY_ARCHIVE_MAGIC.length &&
      archive.subarray(0, 4).equals(EMPTY_ARCHIVE_MAGIC);
    if (!isEmptyArchive) error = "invalid_archive";
  }
  return { entries, ignored, error };
}
