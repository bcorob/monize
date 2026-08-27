/**
 * The notice period a bill reminder accepts, held once on the client so the form
 * refuses what the server would refuse.
 *
 * The server does not clamp an over-bound `reminderDaysBefore` on write -- the
 * DTO rejects it (`@Max(MAX_REMINDER_DAYS_BEFORE)` in
 * `backend/src/scheduled-transactions/reminder-window.ts`) and so does the column
 * (`chk_scheduled_reminder_days_before` in `database/schema.sql`). Without a
 * mirror here, a 400 with a raw validation message is the first the user hears of
 * it, on a form that let them type the value.
 *
 * The bound exists because this number reaches a date computation: a value past
 * JavaScript's `Date` range made the reminder window's upper bound serialize as
 * "NaN-NaN-NaN", which the text-comparing occurrence expander read as an
 * unlimited window (issue #1247 review). A year covers any reminder anyone needs.
 *
 * `src/lib/scheduled-reminder-bounds.contract.test.ts` checks this value against
 * the backend constant and the schema, so the three cannot drift apart quietly.
 */
export const MAX_REMINDER_DAYS_BEFORE = 366;
