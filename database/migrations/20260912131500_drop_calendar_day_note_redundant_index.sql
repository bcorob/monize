-- Drop idx_calendar_day_notes_user_date.
--
-- The table's own UNIQUE constraint, uq_calendar_day_notes_user_date, already
-- builds a btree on exactly (user_id, note_date) in that order, and that is the
-- only predicate this table is ever read by: the range list filters on
-- user_id + note_date, and the upsert names the constraint in
-- ON CONFLICT ON CONSTRAINT. A second index on the same key gives the planner
-- nothing and costs another index write on every save.
--
-- Its own migration rather than an edit to 20260912034642, because that one has
-- merged: the tracker keys on the filename, so an install that already applied
-- it would never re-read a corrected body and would keep the index forever.
-- database/schema.sql drops the CREATE INDEX in the same commit, which is what
-- keeps a fresh install and an upgraded one at the same shape.

DROP INDEX IF EXISTS idx_calendar_day_notes_user_date;
