/**
 * Finds the message separators of an mbox file without reading it whole.
 *
 * The rule is the backend's: a message starts at a line that begins with
 * `From ` and is at the start of the file or follows an empty line (the line
 * ending is LF or CRLF). The scan is one pass over the bytes, line by line; no
 * pattern is built from the input.
 */

export const SCAN_SLICE_BYTES = 4 * 1024 * 1024;

const LF = 10;
const CR = 13;
/** "From " as bytes. */
const SEPARATOR = [0x46, 0x72, 0x6f, 0x6d, 0x20] as const;

/** The bytes begin with the separator text "From ". */
export function startsWithFromLine(bytes: Uint8Array): boolean {
  return SEPARATOR.every((byte, i) => bytes[i] === byte);
}

export interface MboxScanner {
  /**
   * Feed the next bytes of the file, in order. Returns the offsets (from the
   * first byte ever fed) of the separators whose last byte is in `chunk`. State
   * that straddles two chunks (a half-read prefix, a CRLF cut in two) is kept.
   */
  push(chunk: Uint8Array): number[];
}

export function createMboxScanner(): MboxScanner {
  /** Offset of the first byte of `chunk`. */
  let base = 0;
  /** Bytes of the current line seen so far. */
  let linePos = 0;
  /** Every byte of the current line so far matches the start of "From ". */
  let prefixOk = true;
  /** The current line is at the start of the file or follows an empty line. */
  let canStart = true;
  /** The last byte seen was a CR. */
  let lastWasCr = false;
  let lineBegin = 0;

  return {
    push(chunk) {
      const found: number[] = [];
      let i = 0;
      while (i < chunk.length) {
        const newline = chunk.indexOf(LF, i);
        const end = newline === -1 ? chunk.length : newline;
        const before = linePos;
        const limit = Math.min(end, i + (SEPARATOR.length - before));
        for (let k = i; k < limit; k++) {
          if (chunk[k] !== SEPARATOR[before + k - i]) prefixOk = false;
        }
        if (end > i) {
          linePos += end - i;
          lastWasCr = chunk[end - 1] === CR;
        }
        if (
          before < SEPARATOR.length &&
          linePos >= SEPARATOR.length &&
          prefixOk &&
          canStart
        ) {
          found.push(lineBegin);
        }
        if (newline === -1) break;
        canStart = linePos === 0 || (linePos === 1 && lastWasCr);
        linePos = 0;
        prefixOk = true;
        lastWasCr = false;
        lineBegin = base + newline + 1;
        i = newline + 1;
      }
      base += chunk.length;
      return found;
    },
  };
}

/** Offsets of every message separator in `file`; reads it in slices, never whole. */
export async function scanMbox(
  file: Blob,
  opts: { sliceBytes?: number } = {},
): Promise<{ starts: number[] }> {
  const sliceBytes = Math.max(
    1,
    Math.floor(opts.sliceBytes ?? SCAN_SLICE_BYTES),
  );
  const scanner = createMboxScanner();
  const starts: number[] = [];
  for (let offset = 0; offset < file.size; offset += sliceBytes) {
    const buffer = await file
      .slice(offset, Math.min(offset + sliceBytes, file.size))
      .arrayBuffer();
    for (const start of scanner.push(new Uint8Array(buffer)))
      starts.push(start);
  }
  return { starts };
}
