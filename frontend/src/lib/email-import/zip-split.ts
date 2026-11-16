import { startsWithFromLine } from "./mbox-scan";
import { MboxStreamSplitter } from "./mbox-stream-split";
import { PART_MAX_BYTES, nameStem, type UploadPart } from "./upload-plan";

/** The archive is read in slices of this size. */
const READ_SLICE_BYTES = 1024 * 1024;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const FROM_LINE_BYTES = 5;

/**
 * The most bytes the large archives of one selection may expand to in memory.
 * The parts read from a zip are held until they are sent (an `.mbox` picked
 * directly is sliced from the file and costs nothing), so a highly compressed
 * archive is refused past this rather than filling the tab's memory.
 */
export const ZIP_EXPANDED_MAX_BYTES = 512 * 1024 * 1024;

/** What is left of `ZIP_EXPANDED_MAX_BYTES`; shared by every zip of one selection. */
export interface ZipBudget {
  remainingBytes: number;
}

export function newZipBudget(): ZipBudget {
  return { remainingBytes: ZIP_EXPANDED_MAX_BYTES };
}

/** Thrown to stop the inflater when the budget is spent. */
class BudgetSpent extends Error {}

export interface ZipSplitResult {
  parts: UploadPart[];
  /** Entries that are not mail files (other files, folders, a nested zip). */
  ignoredEntries: number;
  /** Single messages above the part limit; they are not sent. */
  oversizedMessages: number;
  /**
   * `invalid_archive` when the file cannot be read as a zip, `archive_too_large`
   * when it expands past the budget; `parts` is then empty.
   */
  error: "invalid_archive" | "archive_too_large" | null;
}

export interface ZipSplitOptions {
  sliceBytes?: number;
  maxPartBytes?: number;
  /** Shared across a selection; a fresh `ZIP_EXPANDED_MAX_BYTES` when absent. */
  budget?: ZipBudget;
}

/** A `.zip` by its name, or by the magic number of its first entry. */
export function looksLikeZip(name: string, head: Uint8Array): boolean {
  return (
    name.toLowerCase().endsWith(".zip") ||
    ZIP_MAGIC.every((byte, i) => head[i] === byte)
  );
}

type EntryKind = "mbox" | "message" | "sniff" | "ignore";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function classify(path: string): EntryKind {
  const lower = path.toLowerCase();
  if (lower.endsWith("/") || lower.includes("__macosx/")) return "ignore";
  const base = baseName(lower);
  if (base === "" || base.startsWith("._")) return "ignore";
  if (base.endsWith(".mbox") || base.endsWith(".mbx")) return "mbox";
  if (base.endsWith(".eml") || base.endsWith(".msg")) return "message";
  return base.includes(".") ? "ignore" : "sniff";
}

/**
 * Reads a large `.zip` in the browser and returns the mail in it as upload parts.
 * `fflate` is loaded here, by a dynamic import, so only a person who picks a large
 * archive downloads it. An `.mbox` entry is cut as it inflates, so memory holds
 * about one part, not the entry. Nothing is written to disk.
 */
export async function splitZip(
  file: File,
  options: ZipSplitOptions = {},
): Promise<ZipSplitResult> {
  const sliceBytes = options.sliceBytes ?? READ_SLICE_BYTES;
  const maxPartBytes = options.maxPartBytes ?? PART_MAX_BYTES;
  const origin = file.name;
  const archiveStem = nameStem(origin);
  const parts: UploadPart[] = [];
  let ignoredEntries = 0;
  let oversizedMessages = 0;
  let entries = 0;
  const budget = options.budget ?? newZipBudget();
  let spent = false;
  /** Counts inflated bytes that are kept, before they are kept. */
  const account = (length: number) => {
    budget.remainingBytes -= length;
    if (budget.remainingBytes < 0) {
      spent = true;
      throw new BudgetSpent();
    }
  };

  const { Unzip, UnzipInflate, UnzipPassThrough } = await import("fflate");
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  unzip.onfile = (entry) => {
    entries += 1;
    const kind = classify(entry.name);
    if (kind === "ignore") {
      ignoredEntries += 1;
      return;
    }
    const base = baseName(entry.name);

    if (kind === "message") {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let tooLarge = false;
      entry.ondata = (error, data, final) => {
        if (error) throw error;
        if (!tooLarge) {
          size += data.length;
          if (size > maxPartBytes) {
            tooLarge = true;
            chunks.length = 0;
            oversizedMessages += 1;
          } else {
            account(data.length);
            chunks.push(data);
          }
        }
        if (final && !tooLarge) {
          parts.push({
            file: new File(chunks as BlobPart[], base),
            origin,
            messages: 1,
          });
        }
      };
      entry.start();
      return;
    }

    let splitter: MboxStreamSplitter | null = null;
    const startSplitter = () => {
      splitter = new MboxStreamSplitter({
        stem: `${archiveStem}-${nameStem(base)}`,
        maxPartBytes,
        onPart: (part, messages) =>
          parts.push({ file: part, origin, messages }),
      });
      return splitter;
    };
    if (kind === "mbox") startSplitter();

    // An entry with no extension is mail only when it starts with "From ".
    const head: Uint8Array[] = [];
    let headSize = 0;
    let undecided = kind === "sniff";
    let dropped = false;

    entry.ondata = (error, data, final) => {
      if (error) throw error;
      if (dropped) return;
      if (undecided) {
        head.push(data);
        headSize += data.length;
        if (headSize < FROM_LINE_BYTES && !final) return;
        const joined = new Uint8Array(headSize);
        let at = 0;
        for (const piece of head) {
          joined.set(piece, at);
          at += piece.length;
        }
        undecided = false;
        if (!startsWithFromLine(joined)) {
          dropped = true;
          ignoredEntries += 1;
          return;
        }
        account(joined.length);
        startSplitter().push(joined);
      } else if (splitter) {
        account(data.length);
        splitter.push(data);
      }
      if (final && splitter) {
        splitter.finish();
        oversizedMessages += splitter.oversized;
      }
    };
    entry.start();
  };

  try {
    for (let offset = 0; offset < file.size; offset += sliceBytes) {
      const end = Math.min(offset + sliceBytes, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      unzip.push(new Uint8Array(buffer), end >= file.size);
    }
  } catch {
    return {
      parts: [],
      ignoredEntries: 0,
      oversizedMessages: 0,
      error: spent ? "archive_too_large" : "invalid_archive",
    };
  }
  if (entries === 0) {
    return {
      parts: [],
      ignoredEntries: 0,
      oversizedMessages: 0,
      error: "invalid_archive",
    };
  }
  return { parts, ignoredEntries, oversizedMessages, error: null };
}
