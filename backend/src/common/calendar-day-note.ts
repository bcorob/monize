/**
 * How long a calendar day note may be.
 *
 * 2,000 characters: a note on a day is a reminder, an explanation of a figure,
 * or the reason a bill moved -- longer than a transaction's description because
 * it describes a day rather than one row, and short enough that the cell can
 * show a first line and the panel the whole thing without a scrollbar.
 *
 * Unlike the transaction note, this number IS enforced by the database:
 * `calendar_day_notes.ck_calendar_day_notes_body_length` carries it, so raising
 * it takes a migration. Three places must agree -- this constant, that CHECK,
 * and `frontend/src/lib/calendar-day-note.ts`, which is what stops the user at
 * the limit instead of letting the save come back a bare 400 --
 * and `calendar-day-note.contract.spec.ts` fails when any two of them differ.
 */
export const CALENDAR_DAY_NOTE_MAX_LENGTH = 2000;

/**
 * How many days a note's span may cover beyond its first.
 *
 * A note covers `note_date` through `end_date` inclusive, so the longest
 * allowed note is 367 days: a whole leap year and the day it started on. A note
 * is a vacation, a trip or an illness, not a decade -- and an unbounded span
 * would let one row cover every grid the calendar can draw, which is a note
 * nobody can get rid of from a day panel.
 *
 * Enforced by `ck_calendar_day_notes_span`, mirrored by
 * `frontend/src/lib/calendar-day-note.ts`, and held equal across the three by
 * `calendar-day-note.contract.spec.ts`.
 */
export const CALENDAR_DAY_NOTE_MAX_SPAN_DAYS = 366;
