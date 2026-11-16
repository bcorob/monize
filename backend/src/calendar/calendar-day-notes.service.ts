import { ConflictException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";

/** One day note, as every route returns it. */
export interface DayNote {
  /** The first day the note covers, `YYYY-MM-DD`. */
  startDate: string;
  /** The last day it covers, inclusive; equal to `startDate` for one day. */
  endDate: string;
  body: string;
  updatedAt: string;
}

/** The span and body one save asks for. */
export interface DayNoteSpan {
  startDate: string;
  endDate: string;
  body: string;
}

/** The row shape the statements below select. */
interface DayNoteRow {
  note_date: string;
  end_date: string;
  body: string;
  updated_at: string | Date;
}

/** PostgreSQL's `exclusion_violation`. */
const EXCLUSION_VIOLATION = "23P01";

/**
 * Read and write the notes a user keeps over calendar dates.
 *
 * A note covers a RUN of consecutive days -- `note_date` through `end_date`,
 * inclusive -- so one row is a vacation rather than one box on the grid. Two
 * spans of one user may not overlap, which is what makes "the note covering
 * this day" a question with one answer and lets the editor be opened from any
 * day the span touches. The mechanism is the exclusion constraint
 * `ex_calendar_day_notes_user_span`, not a check this service performs: a read
 * followed by a decision would let two saves interleave between them
 * (INV-DAYNOTE-001, `docs/concurrency-and-idempotency.md`).
 *
 * The calendar's only write path, and it moves no money: nothing financial
 * reads this table, no balance cache is invalidated by a save, and the routes
 * are owner-only (a delegate acting for the owner gets no note surface at all).
 *
 * `userId` is the caller's, from the JWT, on every route. It is never read from
 * the request, and the RLS policy on the table is the second line of that same
 * defence.
 */
@Injectable()
export class CalendarDayNotesService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Every note whose span TOUCHES the range, first day first.
   *
   * Overlap, not containment: a note that started before the grid and ends
   * inside it covers days the reader is looking at, and a query keyed on
   * `note_date` alone would drop it -- leaving the middle of a vacation
   * unmarked on the month it runs through.
   */
  async list(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<DayNote[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<DayNoteRow>(
        await m.query(
          `SELECT note_date::TEXT AS note_date, end_date::TEXT AS end_date,
                  body, updated_at
             FROM calendar_day_notes
            WHERE user_id = $1
              AND note_date <= $3::DATE
              AND end_date >= $2::DATE
            ORDER BY note_date`,
          [userId, startDate, endDate],
        ),
      ),
    );
    return rows.map(toDayNote);
  }

  /**
   * Write the note the reader had open on `anchorDate`, whole.
   *
   * `anchorDate` is the day the panel was showing, not the note's first day:
   * that is what lets a five-day note be edited from its third day, and what
   * lets the same request move the span's start without the client having to
   * delete a row and create another (two writes, with a window between them
   * where the note does not exist).
   *
   * ONE statement. The CTEs resolve the covering row, update it if there is one
   * and insert if there is not, in a single snapshot -- so there is no read the
   * caller could act on stale. Two concurrent creates for the same day both see
   * no target and both insert; the exclusion constraint refuses the second, and
   * `ConflictException` is what the loser is told. The row is RETURNINGed rather
   * than echoed from the request, so a client adopts what was actually stored.
   */
  async upsert(
    userId: string,
    anchorDate: string,
    span: DayNoteSpan,
  ): Promise<DayNote> {
    const rows = await withScopedDb(this.dataSource, async (m) => {
      try {
        return returnedRows<DayNoteRow>(
          await m.query(
            `WITH target AS (
               SELECT id FROM calendar_day_notes
                WHERE user_id = $1
                  AND $2::DATE BETWEEN note_date AND end_date
             ),
             updated AS (
               UPDATE calendar_day_notes AS c
                  SET note_date = $3::DATE,
                      end_date = $4::DATE,
                      body = $5,
                      updated_at = CURRENT_TIMESTAMP
                 FROM target
                WHERE c.id = target.id
             RETURNING c.note_date, c.end_date, c.body, c.updated_at
             ),
             inserted AS (
               INSERT INTO calendar_day_notes (user_id, note_date, end_date, body)
               SELECT $1, $3::DATE, $4::DATE, $5
                WHERE NOT EXISTS (SELECT 1 FROM target)
             RETURNING note_date, end_date, body, updated_at
             )
             SELECT note_date::TEXT AS note_date, end_date::TEXT AS end_date,
                    body, updated_at
               FROM updated
              UNION ALL
             SELECT note_date::TEXT AS note_date, end_date::TEXT AS end_date,
                    body, updated_at
               FROM inserted`,
            [userId, anchorDate, span.startDate, span.endDate, span.body],
          ),
        );
      } catch (error) {
        // The span the caller asked for runs over another note of theirs. A
        // 409 rather than a 500: the request is well-formed and the state it
        // collides with is one the reader can see and move.
        if (isExclusionViolation(error)) {
          throw new ConflictException(
            tr(
              "errors.calendar.noteOverlaps",
              "Those days are already covered by another note",
            ),
          );
        }
        throw error;
      }
    });
    return toDayNote(rows[0]);
  }

  /**
   * Remove the note covering one day, however many days it covers.
   *
   * Keyed on the day the reader had open rather than the note's first day, for
   * the reason the upsert is: the panel showing the fourth day of a vacation is
   * showing that note, and Delete there means that note.
   *
   * Idempotent: deleting a day that holds no note succeeds. A 404 here would
   * describe a state the caller asked for and already has, and would turn a
   * double-click into an error.
   */
  async remove(userId: string, date: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `DELETE FROM calendar_day_notes
          WHERE user_id = $1
            AND $2::DATE BETWEEN note_date AND end_date`,
        [userId, date],
      ),
    );
  }
}

/**
 * The driver said the exclusion constraint refused the row.
 *
 * TypeORM wraps a driver error in `QueryFailedError` and keeps the original
 * under `driverError`, so the SQLSTATE is read from there; the bare `code` arm
 * is for a driver (and a test double) that throws the pg error itself.
 */
function isExclusionViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  return (
    candidate.code === EXCLUSION_VIOLATION ||
    candidate.driverError?.code === EXCLUSION_VIOLATION
  );
}

function toDayNote(row: DayNoteRow): DayNote {
  return {
    startDate: row.note_date,
    endDate: row.end_date,
    body: row.body,
    updatedAt:
      typeof row.updated_at === "string"
        ? row.updated_at
        : row.updated_at.toISOString(),
  };
}
