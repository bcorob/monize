/**
 * One free-text note the reader keeps over a run of consecutive calendar days.
 *
 * A one-day note has `startDate === endDate`; a vacation is one note covering
 * every day between them. The server refuses two notes of one user whose spans
 * overlap (`ex_calendar_day_notes_user_span`), which is what makes "the note
 * covering this day" a question with one answer and lets the editor be opened
 * from any day the span touches.
 *
 * Owner-only: an acting delegate has no note surface at all, and the server has
 * no route they could reach either (design decision 12).
 */
export interface DayNote {
  /** The first day the note covers, `YYYY-MM-DD`. */
  startDate: string;
  /** The last day it covers, inclusive. */
  endDate: string;
  body: string;
  /** When the server last stored it, ISO. The server's clock, not the browser's. */
  updatedAt: string;
}
