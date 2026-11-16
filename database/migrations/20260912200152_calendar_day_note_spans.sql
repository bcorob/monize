-- Let one calendar day note cover a run of consecutive days.
--
-- `note_date` stops being "the day" and becomes the first day of a span that
-- ends on the new `end_date`, inclusive at both ends. Every existing note is a
-- one-day span, which is what the backfill writes.
--
-- The UNIQUE constraint goes because it no longer says the thing it was there
-- to say. "A user holds at most one note per date" used to follow from one row
-- per date; with spans it is a statement about ranges, and the mechanism for it
-- is an exclusion constraint over daterange: two spans of the same user whose
-- inclusive ranges overlap cannot both exist. That is what lets the client keep
-- reading a day as "the note covering it", and what lets the editor be reached
-- from any day the span touches (INV-DAYNOTE-001).
--
-- btree_gist is what puts the equality-only `user_id` into a GiST index beside
-- the range; without it the constraint cannot be declared at all.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE calendar_day_notes ADD COLUMN IF NOT EXISTS end_date DATE;

UPDATE calendar_day_notes SET end_date = note_date WHERE end_date IS NULL;

ALTER TABLE calendar_day_notes ALTER COLUMN end_date SET NOT NULL;

-- A span runs forwards and is bounded: a note is a vacation or an event, not a
-- decade. The upper bound is a year and a day, so a whole leap year fits.
ALTER TABLE calendar_day_notes
    DROP CONSTRAINT IF EXISTS ck_calendar_day_notes_span;
ALTER TABLE calendar_day_notes
    ADD CONSTRAINT ck_calendar_day_notes_span
    CHECK (end_date >= note_date AND end_date - note_date <= 366);

ALTER TABLE calendar_day_notes
    DROP CONSTRAINT IF EXISTS uq_calendar_day_notes_user_date;

ALTER TABLE calendar_day_notes
    DROP CONSTRAINT IF EXISTS ex_calendar_day_notes_user_span;
ALTER TABLE calendar_day_notes
    ADD CONSTRAINT ex_calendar_day_notes_user_span
    EXCLUDE USING gist (
        user_id WITH =,
        daterange(note_date, end_date, '[]') WITH &&
    );
