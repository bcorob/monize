/**
 * Pure helpers for the archive import: which format an uploaded file is, and
 * the split of an mbox file (mboxo / mboxrd) into its messages. Nothing here reads a database or the
 * network. The scan is linear over the bytes, line by line, with constant
 * patterns only: no regular expression is built from the input.
 */

export type ArchiveFormat = "eml" | "mbox" | "msg" | "zip";
export type ArchiveFormatError = "unsupported_format" | "empty";

export interface MboxMessage {
  /** The message as the mail server held it: no separator line, `>From ` unescaped. */
  source: Buffer;
  /** The date on the `From ` separator line (UTC), or null when absent or unreadable. */
  separatorDate: Date | null;
}

export interface MboxSplit {
  messages: MboxMessage[];
  /** Separators found after `maxMessages` messages were built; those are not built. */
  truncated: number;
}

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_SPACE = Buffer.from("From ");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** A header line is read within this many bytes (RFC 5322 limit is 998). */
const HEADER_PROBE_BYTES = 998;
/** A separator line longer than this carries no date we read. */
const MAX_SEPARATOR_BYTES = 512;
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+:/;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const ZONE = /^([+-])(\d{2})(\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function startsWith(bytes: Buffer, at: number, prefix: Buffer): boolean {
  if (at + prefix.length > bytes.length) return false;
  return bytes.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0;
}

/** The first line that has content, as latin1 text cut at the probe size. */
function firstContentLine(bytes: Buffer): string {
  let pos = 0;
  while (pos < bytes.length && (bytes[pos] === LF || bytes[pos] === CR)) pos++;
  let end = pos;
  while (
    end < bytes.length &&
    end - pos < HEADER_PROBE_BYTES &&
    bytes[end] !== LF &&
    bytes[end] !== CR
  ) {
    end++;
  }
  return bytes.toString("latin1", pos, end);
}

export function detectArchiveFormat(
  name: string,
  bytes: Buffer,
): ArchiveFormat | { error: ArchiveFormatError } {
  if (bytes.length === 0) return { error: "empty" };
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip") || startsWith(bytes, 0, ZIP_MAGIC)) {
    return "zip";
  }
  if (lower.endsWith(".msg") || startsWith(bytes, 0, OLE_MAGIC)) {
    return "msg";
  }
  if (lower.endsWith(".pst")) return { error: "unsupported_format" };
  const first = firstContentLine(bytes);
  if (
    lower.endsWith(".mbox") ||
    lower.endsWith(".mbx") ||
    first.startsWith("From ")
  ) {
    return "mbox";
  }
  if (lower.endsWith(".eml") || HEADER_NAME.test(first)) return "eml";
  return { error: "unsupported_format" };
}

/**
 * The date of a separator line: `From sender Mon May 22 06:49:17 +0000 2023`, or
 * the asctime form without a zone (read as UTC). Null when it is neither.
 */
function parseSeparatorDate(
  bytes: Buffer,
  start: number,
  end: number,
): Date | null {
  if (end - start > MAX_SEPARATOR_BYTES) return null;
  const tokens = bytes
    .toString("latin1", start, end)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  // tokens: From, sender, [weekday,] month, day, time, [zone,] year
  const monthAt = tokens.findIndex(
    (token, index) =>
      index >= 2 && MONTHS.includes(token.slice(0, 3).toLowerCase()),
  );
  if (monthAt < 0 || tokens.length < monthAt + 4) return null;
  const month = MONTHS.indexOf(tokens[monthAt].slice(0, 3).toLowerCase());
  const day = Number(tokens[monthAt + 1]);
  const time = TIME.exec(tokens[monthAt + 2]);
  const yearToken = tokens[tokens.length - 1];
  if (!time || !Number.isInteger(day) || !/^\d{4}$/.test(yearToken)) {
    return null;
  }
  const zoneToken = tokens.length > monthAt + 4 ? tokens[monthAt + 3] : null;
  const zone = zoneToken === null ? null : ZONE.exec(zoneToken);
  if (zoneToken !== null && zone === null) {
    // `UTC`, `GMT` and the like mean zero; anything else is not read.
    if (!/^(UTC|GMT|Z)$/i.test(zoneToken)) return null;
  }
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = time[3] === undefined ? 0 : Number(time[3]);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  const offsetMinutes = zone
    ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]))
    : 0;
  const utc = Date.UTC(Number(yearToken), month, day, hour, minute, second);
  const result = new Date(utc - offsetMinutes * 60_000);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** True for a line matching `^>+From ` (mboxrd's escaped separator). */
function isEscapedFrom(bytes: Buffer, start: number, end: number): boolean {
  let at = start;
  while (at < end && bytes[at] === GT) at++;
  return (
    at > start &&
    at + FROM_SPACE.length <= end &&
    startsWith(bytes, at, FROM_SPACE)
  );
}

/** One message's bytes between `from` and `to`, each `>From ` line losing one `>`. */
function buildSource(bytes: Buffer, from: number, to: number): Buffer {
  const parts: Buffer[] = [];
  let segment = from;
  let pos = from;
  while (pos < to) {
    const nl = bytes.indexOf(LF, pos);
    const lineEnd = nl === -1 || nl >= to ? to : nl;
    const next = lineEnd === to ? to : lineEnd + 1;
    if (isEscapedFrom(bytes, pos, lineEnd)) {
      if (pos > segment) parts.push(bytes.subarray(segment, pos));
      segment = pos + 1;
    }
    pos = next;
  }
  if (to > segment) parts.push(bytes.subarray(segment, to));
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

function hasContent(source: Buffer): boolean {
  for (const byte of source) {
    if (byte !== LF && byte !== CR && byte !== 0x20 && byte !== 0x09)
      return true;
  }
  return false;
}

/**
 * Split an mbox file. A message starts at a line beginning with `From ` that is
 * at the start of the file or follows an empty line (mboxo's rule, which mboxrd
 * keeps by escaping body lines). Text before the first separator is not a
 * message. At most `maxMessages` are built; the separators after that are only
 * counted in `truncated`.
 */
export function splitMbox(bytes: Buffer, maxMessages: number): MboxSplit {
  const messages: MboxMessage[] = [];
  let truncated = 0;
  let current: { contentStart: number; separatorDate: Date | null } | null =
    null;
  let previousBlank = true;
  let blankStart = -1;

  const finish = (end: number): void => {
    if (current === null) return;
    const source = buildSource(bytes, current.contentStart, end);
    if (hasContent(source)) {
      messages.push({ source, separatorDate: current.separatorDate });
    }
    current = null;
  };

  let pos = 0;
  while (pos < bytes.length) {
    const nl = bytes.indexOf(LF, pos);
    const next = nl === -1 ? bytes.length : nl + 1;
    let contentEnd = nl === -1 ? bytes.length : nl;
    if (contentEnd > pos && bytes[contentEnd - 1] === CR) contentEnd--;
    const blank = contentEnd === pos;

    if (previousBlank && startsWith(bytes, pos, FROM_SPACE)) {
      // The empty line before a separator belongs to the separator, not to the
      // message above it.
      finish(blankStart >= 0 ? blankStart : pos);
      if (messages.length >= maxMessages) {
        truncated++;
      } else {
        current = {
          contentStart: next,
          separatorDate: parseSeparatorDate(bytes, pos, contentEnd),
        };
      }
    }
    previousBlank = blank;
    blankStart = blank ? pos : -1;
    pos = next;
  }
  finish(bytes.length);
  return { messages, truncated };
}
