import { createMboxScanner } from "./mbox-scan";
import {
  PART_MAX_BYTES,
  REQUEST_MAX_MESSAGES,
  mboxPartName,
} from "./upload-plan";

export interface MboxStreamSplitterOptions {
  /** The part names are `<stem>-<n>.mbox`. */
  stem: string;
  onPart: (file: File, messages: number) => void;
  maxPartBytes?: number;
  maxMessages?: number;
}

/**
 * A separator is seen when its fifth byte arrives, so one that starts in the last
 * `KEEP_TAIL` bytes is not known yet. The tail is kept, and a part is cut only once
 * the buffer is `KEEP_TAIL` bytes past the limit, so the cut never depends on the
 * chunk size.
 */
const KEEP_TAIL = 4;

/**
 * Cuts an mbox that arrives in chunks (an archive entry as it inflates) into
 * parts of whole messages, by the same separator rule as `scanMbox`. It holds
 * the bytes of at most one part plus one chunk: a part is emitted as soon as
 * the buffer passes the limit, cut at the last separator that keeps it inside.
 * A message above the limit is dropped and counted in `oversized`; text before
 * the first separator belongs to no message and is dropped.
 */
export class MboxStreamSplitter {
  oversized = 0;

  private readonly scanner = createMboxScanner();
  private readonly maxPartBytes: number;
  private readonly maxMessages: number;
  private chunks: Uint8Array[] = [];
  /** Offset (from the first byte pushed) of the first buffered byte. */
  private bufferBase = 0;
  private total = 0;
  /** Offsets of the separators that start a message not yet emitted. */
  private readonly starts: number[] = [];
  private emitted = 0;

  constructor(private readonly options: MboxStreamSplitterOptions) {
    this.maxPartBytes = options.maxPartBytes ?? PART_MAX_BYTES;
    this.maxMessages = options.maxMessages ?? REQUEST_MAX_MESSAGES;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    for (const start of this.scanner.push(chunk)) this.starts.push(start);
    this.total += chunk.length;
    this.drain(false);
  }

  /** The stream ended: everything still buffered is complete. */
  finish(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.starts.length === 0) {
        this.trimTo(Math.max(this.bufferBase, this.total - KEEP_TAIL));
        return;
      }
      const first = this.starts[0];
      this.trimTo(first);
      const complete = final ? this.starts.length : this.starts.length - 1;
      const bound = (i: number) =>
        i < this.starts.length ? this.starts[i] : this.total;
      const trigger = final
        ? complete > 0
        : this.total - first > this.maxPartBytes + KEEP_TAIL ||
          this.starts.length > this.maxMessages;
      if (!trigger) return;

      let count = 0;
      while (
        count < complete &&
        count < this.maxMessages &&
        bound(count + 1) - first <= this.maxPartBytes
      ) {
        count += 1;
      }
      if (count === 0) {
        // The first message alone is above the limit (whole, or still arriving).
        this.oversized += 1;
        this.starts.shift();
        continue;
      }
      this.emitted += 1;
      const file = new File(
        this.slice(first, bound(count)) as BlobPart[],
        mboxPartName(this.options.stem, this.emitted),
      );
      this.options.onPart(file, count);
      this.starts.splice(0, count);
    }
  }

  /** Views over the buffered bytes in `[from, to)`; nothing is copied. */
  private slice(from: number, to: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    let position = this.bufferBase;
    for (const chunk of this.chunks) {
      const chunkStart = position;
      const chunkEnd = position + chunk.length;
      position = chunkEnd;
      if (chunkEnd <= from) continue;
      if (chunkStart >= to) break;
      out.push(
        chunk.subarray(
          Math.max(from, chunkStart) - chunkStart,
          Math.min(to, chunkEnd) - chunkStart,
        ),
      );
    }
    return out;
  }

  private trimTo(offset: number): void {
    if (offset <= this.bufferBase) return;
    this.chunks = this.slice(offset, this.total);
    this.bufferBase = offset;
  }
}
