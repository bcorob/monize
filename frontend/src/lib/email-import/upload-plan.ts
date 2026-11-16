/**
 * Pure planning of an email import: what is sent, and in which requests.
 *
 * The server's limits stay as they are (at most 20 files, 25 MiB each, 100 MiB
 * and 5,000 messages per request). The browser cuts a large `.mbox` at message
 * boundaries into parts below them and packs the parts into requests.
 */

const MIB = 1024 * 1024;

/** A part stays under the server's 25 MiB per-file limit, with room for the framing. */
export const PART_MAX_BYTES = 24 * MIB;
export const REQUEST_MAX_PARTS = 20;
/**
 * One request holds at most one full part. The frontend's route for this upload
 * buffers what the backend has not read yet (Next.js hands it the body without
 * backpressure), so a request's size is what the frontend may hold at once; the
 * server refuses a body above 26 MiB.
 */
export const REQUEST_MAX_BYTES = PART_MAX_BYTES;
export const REQUEST_MAX_MESSAGES = 5000;
/** One selection may hold this much in total; checked before anything is read. */
export const SELECTION_MAX_BYTES = 1024 * MIB;

/** A file to upload and the selected file it came from. */
export interface UploadPart {
  file: File;
  /** The name of the file the person selected; results are summed under it. */
  origin: string;
  /** Messages in the part; `null` when the browser did not read it. */
  messages: number | null;
}

export type UploadSource =
  /** Sent as it is; the server decides the format. */
  | { kind: "file"; file: File }
  /** An mbox, with the offsets of its separators (`scanMbox`). */
  | { kind: "mbox"; name: string; blob: Blob; starts: readonly number[] };

export interface PlannedParts {
  parts: UploadPart[];
  /** Per origin: single messages above `PART_MAX_BYTES`, which are not sent. */
  oversizedMessages: Array<{ origin: string; count: number }>;
}

export function selectionExceedsLimit(
  files: ReadonlyArray<{ size: number }>,
): boolean {
  return files.reduce((sum, file) => sum + file.size, 0) > SELECTION_MAX_BYTES;
}

/** The name without its last extension: the stem of a part's name. */
export function nameStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The name of the n-th (1-based) mbox part of `stem`. */
export function mboxPartName(stem: string, n: number): string {
  return `${stem}-${n}.mbox`;
}

/**
 * Groups consecutive whole messages of an mbox into parts of at most
 * `PART_MAX_BYTES` and `REQUEST_MAX_MESSAGES` messages. A part is a slice of the
 * blob (nothing is copied). A message above the limit is left out and counted;
 * text before the first separator belongs to no message and is left out.
 */
export function planMbox(
  origin: string,
  blob: Blob,
  starts: readonly number[],
): { parts: UploadPart[]; oversized: number } {
  const stem = nameStem(origin);
  const parts: UploadPart[] = [];
  let oversized = 0;
  let from = -1;
  let to = -1;
  let count = 0;

  const flush = () => {
    if (count === 0) return;
    const file = new File(
      [blob.slice(from, to)],
      mboxPartName(stem, parts.length + 1),
    );
    parts.push({ file, origin, messages: count });
    from = -1;
    count = 0;
  };

  if (starts.length === 0) {
    // Nothing to cut at: the whole file is one message the server could not take.
    return { parts, oversized: blob.size > 0 ? 1 : 0 };
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : blob.size;
    if (end - start > PART_MAX_BYTES) {
      flush();
      oversized += 1;
      continue;
    }
    if (
      count > 0 &&
      (end - from > PART_MAX_BYTES || count >= REQUEST_MAX_MESSAGES)
    )
      flush();
    if (count === 0) from = start;
    to = end;
    count += 1;
  }
  flush();
  return { parts, oversized };
}

export function planParts(sources: readonly UploadSource[]): PlannedParts {
  const parts: UploadPart[] = [];
  const oversizedMessages: PlannedParts["oversizedMessages"] = [];
  for (const source of sources) {
    if (source.kind === "file") {
      parts.push({
        file: source.file,
        origin: source.file.name,
        messages: null,
      });
      continue;
    }
    const planned = planMbox(source.name, source.blob, source.starts);
    parts.push(...planned.parts);
    if (planned.oversized > 0)
      oversizedMessages.push({ origin: source.name, count: planned.oversized });
  }
  return { parts, oversizedMessages };
}

/**
 * Packs parts, in order, into requests of at most `REQUEST_MAX_PARTS` parts,
 * `REQUEST_MAX_BYTES` bytes and `REQUEST_MAX_MESSAGES` known messages. A part
 * whose message count is unknown counts as one.
 */
export function packRequests(parts: readonly UploadPart[]): UploadPart[][] {
  const requests: UploadPart[][] = [];
  let current: UploadPart[] = [];
  let bytes = 0;
  let messages = 0;
  for (const part of parts) {
    const partMessages = part.messages ?? 1;
    const size = part.file.size;
    if (
      current.length > 0 &&
      (current.length >= REQUEST_MAX_PARTS ||
        bytes + size > REQUEST_MAX_BYTES ||
        messages + partMessages > REQUEST_MAX_MESSAGES)
    ) {
      requests.push(current);
      current = [];
      bytes = 0;
      messages = 0;
    }
    current.push(part);
    bytes += size;
    messages += partMessages;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}
