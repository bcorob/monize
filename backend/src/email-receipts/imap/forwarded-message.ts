/**
 * Reading the header block of a FORWARDED order confirmation (design: forwarded
 * emails). A person who forwards a shop's email to the receipts mailbox from
 * their own address makes the mailbox's `From` their own (`gmail.com`) and the
 * `Date` the day they pressed forward, which is days after the purchase. The
 * shop, the subject and the day it wrote are in the forwarded header block the
 * mail client pasted into the text, and this reads them from there.
 *
 * Pure: text in, facts out. Nothing here reads a database, a clock or the
 * process environment, and no regular expression is ever BUILT from the input
 * (every pattern below is a constant), because the text is what a stranger wrote
 * to the user's mailbox. The scan is bounded: only the first
 * `MAX_SCANNED_LINES` lines are read, each cut to `MAX_LINE_CHARS`, and every
 * loop moves forward over what it has read, so the work is linear in the text it
 * looks at, never in the size of the whole message.
 *
 * Recognised block shapes (a marker line, then `Label: value` lines):
 * - Gmail: `---------- Forwarded message ---------` / `---------- Wiadomość
 *   przekazana dalej ---------`; From / Date / Subject / To.
 * - Outlook: `-----Original Message-----` (or the Polish `Wiadomość
 *   oryginalna`), or no marker at all (a `From:` line followed by `Sent:`,
 *   `To:` and `Subject:`); Od / Wysłano / Do / Temat in Polish.
 * - Apple Mail: `Begin forwarded message:`.
 * - Thunderbird: `-------- Forwarded Message --------` / `-------- Przekazana
 *   wiadomość --------`.
 * The labels are English, Polish, German, French and Spanish; the date formats
 * are RFC 2822, ISO 8601 and the long forms the clients above write in English,
 * Polish, German, French and Spanish.
 *
 * A date is read to the DAY (the match window is about days). A client writes
 * the time without a zone, so a stated offset is honoured and an unstated one is
 * read as UTC; the error that leaves is under a day, well inside the window.
 */

/** Only this many lines from the top of the text are looked at. */
export const MAX_SCANNED_LINES = 200;
/** A line is cut to this many characters before it is read. */
const MAX_LINE_CHARS = 1_000;
/** How many nested forwards are followed to the innermost sender. */
const MAX_NESTED_FORWARDS = 3;
/** Header lines read after a marker (a real block has fewer than ten). */
const MAX_HEADER_LINES = 20;
/** Lines between a block's last header and a nested marker that still count as adjacent. */
const MAX_GAP_TO_NESTED_MARKER = 3;
/** The longest value a header keeps. */
const MAX_VALUE_CHARS = 500;
const MAX_ADDRESS_CHARS = 320;
const MAX_NAME_CHARS = 200;
const MAX_DATE_CHARS = 120;

export interface ForwardedOriginal {
  /** The original sender, lower-case. */
  fromAddress: string;
  fromName?: string;
  /** When the original was sent, or null when the header is absent or unreadable. */
  sentAt: Date | null;
  /** The original subject, or null when the block has none. */
  subject: string | null;
  /** Zero-based index of the first line after the header block (blank lines skipped). */
  bodyStartLine: number;
}

// ----------------------------------------------------------------------
// Text helpers
// ----------------------------------------------------------------------

/** Lowercase, with the diacritics of the languages above folded to ASCII. */
const FOLD: Readonly<Record<string, string>> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
  ä: "a",
  ö: "o",
  ü: "u",
  ß: "ss",
  é: "e",
  è: "e",
  ê: "e",
  ë: "e",
  à: "a",
  â: "a",
  î: "i",
  ï: "i",
  ô: "o",
  ù: "u",
  û: "u",
  ç: "c",
  á: "a",
  í: "i",
  ú: "u",
  ñ: "n",
};

function fold(value: string): string {
  const lower = value.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; i += 1) {
    out += FOLD[lower[i]] ?? lower[i];
  }
  return out;
}

/** The first `MAX_SCANNED_LINES` lines, each cut, without splitting the whole text. */
function firstLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < MAX_SCANNED_LINES && start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, Math.min(end, start + MAX_LINE_CHARS));
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    if (end >= text.length) break;
    start = end + 1;
  }
  return lines;
}

/** A line without its quoting (`>` marks), outer spaces and the invisible characters mail clients add. */
function cleanLine(line: string): string {
  let start = 0;
  while (start < line.length) {
    const ch = line[start];
    if (
      ch === ">" ||
      ch === " " ||
      ch === "\t" ||
      ch === " " ||
      ch === "​" ||
      ch === "﻿" ||
      ch === "‎" ||
      ch === "‏"
    ) {
      start += 1;
    } else break;
  }
  return line.slice(start).trimEnd();
}

const isBlank = (line: string): boolean => cleanLine(line) === "";

/** True for a character of the filler around a marker's words. */
const isRule = (ch: string): boolean => ch === "-" || ch === "_" || ch === "=";

// ----------------------------------------------------------------------
// Markers
// ----------------------------------------------------------------------

/** The words of a dashed marker line, folded. */
const DASHED_MARKERS: ReadonlySet<string> = new Set([
  "forwarded message",
  "original message",
  "wiadomosc przekazana dalej",
  "przekazana wiadomosc",
  "wiadomosc oryginalna",
  "weitergeleitete nachricht",
  "ursprungliche nachricht",
  "message transfere",
  "message d'origine",
  "mensaje reenviado",
  "mensaje original",
]);

/** The whole line of an undashed marker (Apple Mail), folded, without its colon. */
const PLAIN_MARKERS: ReadonlySet<string> = new Set([
  "begin forwarded message",
  "poczatek przekazanej wiadomosci",
  "weitergeleitete nachricht",
  "debut du message transfere",
  "inicio del mensaje reenviado",
]);

function isMarker(rawLine: string): boolean {
  const line = cleanLine(rawLine);
  if (line === "") return false;
  if (isRule(line[0]) && isRule(line[line.length - 1])) {
    let from = 0;
    let to = line.length;
    while (from < to && (isRule(line[from]) || line[from] === " ")) from += 1;
    while (to > from && (isRule(line[to - 1]) || line[to - 1] === " ")) to -= 1;
    if (to - from < 3 || line.length - (to - from) < 4) return false;
    return DASHED_MARKERS.has(fold(line.slice(from, to).trim()));
  }
  const bare = line.endsWith(":") ? line.slice(0, -1).trim() : line;
  return PLAIN_MARKERS.has(fold(bare));
}

// ----------------------------------------------------------------------
// Header lines
// ----------------------------------------------------------------------

type HeaderKey = "from" | "date" | "subject" | "to";

const LABELS: Readonly<Record<string, HeaderKey>> = {
  from: "from",
  od: "from",
  de: "from",
  von: "from",
  da: "from",
  date: "date",
  data: "date",
  sent: "date",
  wyslano: "date",
  datum: "date",
  fecha: "date",
  envoye: "date",
  "enviado el": "date",
  gesendet: "date",
  subject: "subject",
  temat: "subject",
  betreff: "subject",
  objet: "subject",
  asunto: "subject",
  oggetto: "subject",
  to: "to",
  do: "to",
  an: "to",
  a: "to",
  pour: "to",
  para: "to",
};

/** The longest label (`enviado el`) plus slack; a longer prefix is not a label. */
const MAX_LABEL_CHARS = 14;

interface HeaderLine {
  key: HeaderKey;
  value: string;
}

/** `Label: value` for a known label, else null. A markdown-bold label (`*From:*`) is read too. */
function readHeaderLine(rawLine: string): HeaderLine | null {
  const line = cleanLine(rawLine);
  const colon = line.indexOf(":");
  if (colon <= 0 || colon > MAX_LABEL_CHARS + 2) return null;
  let label = line.slice(0, colon).trim();
  while (label.startsWith("*") || label.startsWith("_")) label = label.slice(1);
  while (label.endsWith("*") || label.endsWith("_")) label = label.slice(0, -1);
  const key = LABELS[fold(label.trim())];
  if (key === undefined) return null;
  let value = line.slice(colon + 1).trim();
  // Gmail's own text part writes the label bold: `*From:* Name <a@b>`.
  while (
    value.startsWith("*") &&
    value.length > 1 &&
    label !== line.slice(0, colon).trim()
  ) {
    value = value.slice(1).trim();
  }
  return { key, value: value.slice(0, MAX_VALUE_CHARS) };
}

interface HeaderBlock {
  headers: Partial<Record<HeaderKey, string>>;
  /** Index of the line after the last header line. */
  end: number;
}

/** A client wraps text at this many columns when it breaks a long header line. */
const WRAP_COLUMNS = 76;
const MIN_WRAPPED_LINE = 60;

/**
 * True when `next` is the rest of a line a mail client hard-wrapped: `previous`
 * was nearly as wide as the wrap column and the first word of `next` would not
 * have fitted on it.
 */
function wrapsOnto(previous: string | undefined, next: string): boolean {
  if (previous === undefined) return false;
  const width = previous.trimEnd().length;
  const firstWord = next.trim().split(/\s+/)[0] ?? "";
  return (
    width >= MIN_WRAPPED_LINE && width + 1 + firstWord.length > WRAP_COLUMNS
  );
}

/**
 * The `Label: value` lines starting at `from`. A line that starts with white
 * space continues the previous value (a wrapped `To:`); the first blank line or
 * line of anything else ends the block. The first value of a label wins.
 */
function readHeaderBlock(lines: readonly string[], from: number): HeaderBlock {
  const headers: Partial<Record<HeaderKey, string>> = {};
  let index = from;
  let last: HeaderKey | null = null;
  let count = 0;
  while (index < lines.length && count < MAX_HEADER_LINES) {
    const raw = lines[index];
    const header = readHeaderLine(raw);
    if (header !== null) {
      if (headers[header.key] === undefined) headers[header.key] = header.value;
      last = header.key;
      index += 1;
      count += 1;
      continue;
    }
    const startsWithSpace = raw.startsWith(" ") || raw.startsWith("\t");
    if (
      last === "subject" &&
      !startsWithSpace &&
      !isBlank(raw) &&
      wrapsOnto(lines[index - 1], raw)
    ) {
      // Gmail hard-wraps a long forwarded `Subject:` at about 76 columns and
      // leaves the rest, unindented, on the next line.
      const joined = `${headers.subject ?? ""} ${cleanLine(raw)}`.trim();
      headers.subject = joined.slice(0, MAX_VALUE_CHARS);
      index += 1;
      count += 1;
      continue;
    }
    if (last !== null && startsWithSpace && !isBlank(raw)) {
      const extra = cleanLine(raw);
      const joined = `${headers[last] ?? ""} ${extra}`.trim();
      headers[last] = joined.slice(0, MAX_VALUE_CHARS);
      index += 1;
      count += 1;
      continue;
    }
    break;
  }
  return { headers, end: index };
}

// ----------------------------------------------------------------------
// Addresses
// ----------------------------------------------------------------------

const ADDRESS_CHAR_STOPS = new Set([
  " ",
  "\t",
  "<",
  ">",
  '"',
  "'",
  ",",
  ";",
  "(",
  ")",
  "[",
  "]",
  "*",
]);

function isAddress(candidate: string): boolean {
  if (candidate.length < 3 || candidate.length > MAX_ADDRESS_CHARS)
    return false;
  const at = candidate.indexOf("@");
  if (at <= 0 || at !== candidate.lastIndexOf("@")) return false;
  const domain = candidate.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0 || dot === domain.length - 1 || domain.length < 4) return false;
  for (let i = 0; i < candidate.length; i += 1) {
    if (ADDRESS_CHAR_STOPS.has(candidate[i])) return false;
  }
  return true;
}

function stripMailto(value: string): string {
  return value.toLowerCase().startsWith("mailto:") ? value.slice(7) : value;
}

/** The first address of a `From` value: inside `<...>` when there is one, else a bare token. */
function readAddress(
  value: string,
): { address: string; name: string | null } | null {
  const open = value.indexOf("<");
  if (open !== -1) {
    const close = value.indexOf(">", open + 1);
    if (close !== -1) {
      const inner = stripMailto(
        value.slice(open + 1, close).trim(),
      ).toLowerCase();
      // A pair of angle brackets names the address; one that does not hold a
      // usable one is a sender nobody can reach, not a cue to look elsewhere.
      return isAddress(inner)
        ? { address: inner, name: cleanName(value.slice(0, open)) }
        : null;
    }
  }
  let token = "";
  for (let i = 0; i <= value.length; i += 1) {
    const ch = i < value.length ? value[i] : " ";
    if (ch === " " || ch === "\t" || ch === "," || ch === ";") {
      const candidate = stripMailto(
        token.replace(/^[[<("'*]+|[\]>)"'*.]+$/g, ""),
      ).toLowerCase();
      if (isAddress(candidate)) {
        return {
          address: candidate,
          name: cleanName(value.slice(0, Math.max(0, i - token.length))),
        };
      }
      token = "";
    } else {
      token += ch;
    }
  }
  return null;
}

function cleanName(raw: string): string | null {
  let name = raw.trim();
  while (
    name.length > 0 &&
    (name[0] === '"' || name[0] === "'" || name[0] === "*")
  )
    name = name.slice(1);
  while (
    name.length > 0 &&
    (name.endsWith('"') || name.endsWith("'") || name.endsWith("*"))
  ) {
    name = name.slice(0, -1);
  }
  name = name.trim();
  return name === "" ? null : name.slice(0, MAX_NAME_CHARS);
}

// ----------------------------------------------------------------------
// Dates
// ----------------------------------------------------------------------

/** Month words, folded: English, Polish (short, nominative, genitive), German, French, Spanish. */
const MONTHS: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  const add = (month: number, ...names: string[]): void => {
    for (const name of names) table[fold(name)] = month;
  };
  add(
    1,
    "jan",
    "january",
    "sty",
    "styczen",
    "stycznia",
    "januar",
    "janvier",
    "janv",
    "enero",
    "ene",
  );
  add(
    2,
    "feb",
    "february",
    "lut",
    "luty",
    "lutego",
    "februar",
    "fevrier",
    "fevr",
    "febrero",
  );
  add(3, "mar", "march", "marzec", "marca", "marz", "mars", "marzo");
  add(
    4,
    "apr",
    "april",
    "kwi",
    "kwiecien",
    "kwietnia",
    "avril",
    "avr",
    "abr",
    "abril",
  );
  add(5, "may", "maj", "maja", "mai", "mayo");
  add(6, "jun", "june", "cze", "czerwiec", "czerwca", "juni", "juin", "junio");
  add(
    7,
    "jul",
    "july",
    "lip",
    "lipiec",
    "lipca",
    "juli",
    "juillet",
    "juil",
    "julio",
  );
  add(
    8,
    "aug",
    "august",
    "sie",
    "sierpien",
    "sierpnia",
    "aout",
    "ago",
    "agosto",
  );
  add(
    9,
    "sep",
    "sept",
    "september",
    "wrz",
    "wrzesien",
    "wrzesnia",
    "septembre",
    "septiembre",
    "set",
  );
  add(
    10,
    "oct",
    "october",
    "paz",
    "pazdziernik",
    "pazdziernika",
    "okt",
    "oktober",
    "octobre",
    "octubre",
  );
  add(
    11,
    "nov",
    "november",
    "lis",
    "listopad",
    "listopada",
    "novembre",
    "noviembre",
  );
  add(
    12,
    "dec",
    "december",
    "gru",
    "grudzien",
    "grudnia",
    "dez",
    "dezember",
    "decembre",
    "dec",
    "dic",
    "diciembre",
  );
  return table;
})();

/** Named zones the clients above write after a time; minutes east of UTC. */
const ZONES: Readonly<Record<string, number>> = {
  utc: 0,
  gmt: 0,
  z: 0,
  cet: 60,
  cest: 120,
  eet: 120,
  eest: 180,
  wet: 0,
  west: 60,
  bst: 60,
  ist: 60,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
};

const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= "0" && ch <= "9";
const isLetter = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();

function validDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number,
): Date | null {
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  // A 31 February rolls over into March; that is not a date the header named.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return null;
  const result = new Date(utc - offsetMinutes * 60_000);
  return Number.isNaN(result.getTime()) ? null : result;
}

interface TimeRead {
  hour: number;
  minute: number;
  second: number;
  /** The text with the time blanked out, and the text that followed it. */
  rest: string;
  after: string;
}

/** The first `h:mm[:ss]` in the text, blanked out of `rest`. */
function readTime(text: string): TimeRead | null {
  for (
    let colon = text.indexOf(":");
    colon !== -1;
    colon = text.indexOf(":", colon + 1)
  ) {
    if (!isDigit(text[colon - 1]) || !isDigit(text[colon + 1])) continue;
    let hourStart = colon;
    while (
      hourStart > 0 &&
      isDigit(text[hourStart - 1]) &&
      colon - hourStart < 2
    )
      hourStart -= 1;
    let end = colon + 1;
    while (end < text.length && isDigit(text[end]) && end - colon - 1 < 2)
      end += 1;
    const hour = Number(text.slice(hourStart, colon));
    const minute = Number(text.slice(colon + 1, end));
    let second = 0;
    if (text[end] === ":" && isDigit(text[end + 1])) {
      let secondEnd = end + 1;
      while (
        secondEnd < text.length &&
        isDigit(text[secondEnd]) &&
        secondEnd - end - 1 < 2
      )
        secondEnd += 1;
      second = Number(text.slice(end + 1, secondEnd));
      end = secondEnd;
    }
    return {
      hour,
      minute,
      second,
      rest: `${text.slice(0, hourStart)} ${text.slice(end)}`,
      after: text.slice(end),
    };
  }
  return null;
}

/** `AM` / `PM` straight after the time (`a.m.` too), or null. */
function readMeridiem(after: string): { pm: boolean; consumed: number } | null {
  let i = 0;
  while (
    i < after.length &&
    (after[i] === " " || after[i] === " " || after[i] === " ")
  )
    i += 1;
  const a = after[i]?.toLowerCase();
  if (a !== "a" && a !== "p") return null;
  let j = i + 1;
  if (after[j] === ".") j += 1;
  if (after[j]?.toLowerCase() !== "m") return null;
  j += 1;
  if (after[j] === ".") j += 1;
  if (j < after.length && isLetter(after[j])) return null;
  return { pm: a === "p", consumed: j };
}

/** `+0200`, `+02:00`, `GMT+2`, `UTC`, `CEST`, `Z` right after the time, in minutes east of UTC. */
function readOffset(after: string): number | null {
  let i = 0;
  while (i < after.length && (after[i] === " " || after[i] === " ")) i += 1;
  let word = "";
  while (i < after.length && isLetter(after[i]) && word.length < 6) {
    word += after[i];
    i += 1;
  }
  const zone = word === "" ? null : (ZONES[word.toLowerCase()] ?? null);
  if (word !== "" && zone === null) return null;
  if ((after[i] === "+" || after[i] === "-") && isDigit(after[i + 1])) {
    const sign = after[i] === "-" ? -1 : 1;
    let j = i + 1;
    let digits = "";
    while (
      j < after.length &&
      digits.length < 4 &&
      (isDigit(after[j]) || (after[j] === ":" && digits.length === 2))
    ) {
      if (after[j] !== ":") digits += after[j];
      j += 1;
    }
    if (digits.length === 1 || digits.length === 2) {
      return sign * Number(digits) * 60;
    }
    if (digits.length === 4) {
      return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    }
    return null;
  }
  return zone;
}

/** The numeric tokens (digit runs) and the month word of a date with the time taken out. */
function readCalendar(text: string): {
  numbers: number[];
  lengths: number[];
  month: number | null;
} {
  const numbers: number[] = [];
  const lengths: number[] = [];
  let month: number | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isDigit(ch)) {
      let j = i;
      while (j < text.length && isDigit(text[j]) && j - i < 5) j += 1;
      numbers.push(Number(text.slice(i, j)));
      lengths.push(j - i);
      i = j;
    } else if (isLetter(ch)) {
      let j = i;
      while (j < text.length && isLetter(text[j]) && j - i < 30) j += 1;
      if (month === null) {
        const found = MONTHS[fold(text.slice(i, j))];
        if (found !== undefined) month = found;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return { numbers, lengths, month };
}

/**
 * A forwarded header's date, or null. ISO 8601 (`2026-08-31T10:15:00+02:00`),
 * numeric `31.08.2026` (day first, the only order a client writes with dots),
 * and the long forms with a month name in any language of `MONTHS`, with or
 * without a weekday, a time, AM/PM and a zone. A string that does not hold a
 * day, a month and a year is null: nothing is guessed, and the engine's own
 * permissive date parser is never used on the text.
 */
export function parseForwardedDate(raw: string): Date | null {
  const text = raw.trim().slice(0, MAX_DATE_CHARS);
  if (text === "") return null;

  const time = readTime(text);
  const calendarText = time ? time.rest : text;
  let hour = time?.hour ?? 0;
  const minute = time?.minute ?? 0;
  const second = time?.second ?? 0;
  let offset = 0;
  if (time) {
    const meridiem = readMeridiem(time.after);
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem.pm ? 12 : 0);
      offset = readOffset(time.after.slice(meridiem.consumed)) ?? 0;
    } else {
      offset = readOffset(time.after) ?? 0;
    }
  }

  // ISO 8601: yyyy-mm-dd
  if (
    calendarText.trim().length >= 10 &&
    isDigit(calendarText.trim()[0]) &&
    calendarText.trim()[4] === "-" &&
    calendarText.trim()[7] === "-"
  ) {
    const t = calendarText.trim();
    const year = Number(t.slice(0, 4));
    const month = Number(t.slice(5, 7));
    const day = Number(t.slice(8, 10));
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day)
    ) {
      return validDate(year, month, day, hour, minute, second, offset);
    }
    return null;
  }

  const calendar = readCalendar(calendarText);
  if (calendar.month !== null) {
    // Day and year are the numbers that are not the other: a 4-digit one is the year.
    let year: number | null = null;
    let day: number | null = null;
    for (let i = 0; i < calendar.numbers.length; i += 1) {
      const length = calendar.lengths[i];
      const value = calendar.numbers[i];
      if (length === 4 && year === null) year = value;
      else if (length <= 2 && day === null) day = value;
    }
    if (year === null || day === null) return null;
    return validDate(year, calendar.month, day, hour, minute, second, offset);
  }

  // dd.mm.yyyy and dd/mm/yyyy with a 4-digit year; dd/mm is unambiguous only
  // when the day cannot be a month.
  const t = calendarText.trim();
  const separators = [".", "/", "-"];
  const first = t.search(/[./-]/);
  if (first > 0 && separators.includes(t[first])) {
    const parts: string[] = [];
    let part = "";
    for (let i = 0; i < t.length && parts.length < 3; i += 1) {
      if (isDigit(t[i])) part += t[i];
      else if (part !== "" && (t[i] === "." || t[i] === "/" || t[i] === "-")) {
        parts.push(part);
        part = "";
      } else if (part !== "") break;
    }
    if (part !== "" && parts.length < 3) parts.push(part);
    if (
      parts.length === 3 &&
      parts[2].length === 4 &&
      parts[0].length <= 2 &&
      parts[1].length <= 2
    ) {
      const day = Number(parts[0]);
      const month = Number(parts[1]);
      const year = Number(parts[2]);
      if (t[first] === "/" && day <= 12 && month <= 12 && day !== month)
        return null;
      return validDate(year, month, day, hour, minute, second, offset);
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// The detector
// ----------------------------------------------------------------------

interface ReadBlock {
  original: Omit<ForwardedOriginal, "bodyStartLine">;
  end: number;
}

/** One header block read from `from`: its facts and where it ends, or null when it names no sender. */
function readBlock(
  lines: readonly string[],
  from: number,
  requireDateAndRecipient: boolean,
): ReadBlock | null {
  const block = readHeaderBlock(lines, from);
  const sender = block.headers.from;
  if (sender === undefined) return null;
  if (requireDateAndRecipient) {
    // A block with no marker is a `From:` line that happens to open a line: it
    // is a forwarded header only with the lines every client writes beside it.
    if (block.headers.date === undefined) return null;
    if (block.headers.to === undefined && block.headers.subject === undefined)
      return null;
  }
  const address = readAddress(sender);
  if (address === null) return null;
  const subject = block.headers.subject?.trim();
  return {
    original: {
      fromAddress: address.address,
      ...(address.name ? { fromName: address.name } : {}),
      sentAt:
        block.headers.date === undefined
          ? null
          : parseForwardedDate(block.headers.date),
      subject: subject === undefined || subject === "" ? null : subject,
    },
    end: block.end,
  };
}

function skipBlank(lines: readonly string[], from: number): number {
  let index = from;
  while (index < lines.length && isBlank(lines[index])) index += 1;
  return index;
}

/**
 * The original sender, date and subject of a forwarded message, read from the
 * header block a mail client pasted into the top of the text, or null when the
 * text holds no such block (see the module comment for the shapes). The
 * outermost block is read first and nested forwards (a forward of a forward,
 * adjacent to one another) are followed to the innermost, at most three deep.
 */
export function detectForwardedOriginal(
  text: string,
): ForwardedOriginal | null {
  if (typeof text !== "string" || text === "") return null;
  const lines = firstLines(text);

  // 1. A marker line, then the block.
  for (let i = 0; i < lines.length; i += 1) {
    if (!isMarker(lines[i])) continue;
    const first = readBlock(lines, skipBlank(lines, i + 1), false);
    if (first === null) continue;
    let found: ReadBlock = first;
    let depth = 1;
    // A forward of a forward: another marker right after this block's headers.
    while (depth < MAX_NESTED_FORWARDS) {
      let probe = found.end;
      let nested: ReadBlock | null = null;
      const limit = Math.min(
        lines.length,
        found.end + MAX_GAP_TO_NESTED_MARKER + 1,
      );
      for (; probe < limit; probe += 1) {
        if (isMarker(lines[probe])) {
          nested = readBlock(lines, skipBlank(lines, probe + 1), false);
          break;
        }
        if (!isBlank(lines[probe])) break;
      }
      if (nested === null) break;
      found = nested;
      depth += 1;
    }
    return { ...found.original, bodyStartLine: skipBlank(lines, found.end) };
  }

  // 2. No marker (Outlook): a header block that carries its own sent date.
  for (let i = 0; i < lines.length; i += 1) {
    const header = readHeaderLine(lines[i]);
    if (header === null || header.key !== "from") continue;
    const found = readBlock(lines, i, true);
    if (found === null) continue;
    return { ...found.original, bodyStartLine: skipBlank(lines, found.end) };
  }
  return null;
}
