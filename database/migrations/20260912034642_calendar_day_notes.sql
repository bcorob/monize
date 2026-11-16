-- One free-text note per user per calendar date, written and read from the
-- calendar's day panel. It moves no money and nothing financial reads it.
--
-- UNIQUE (user_id, note_date) is what makes the write a single statement: the
-- upsert is INSERT ... ON CONFLICT DO UPDATE, so two saves of the same day
-- cannot interleave and a save never has to read first.
--
-- Direct RLS bucket, owner only: no delegate arm, so the uniform policy covers
-- it with no entry in any map.

CREATE TABLE IF NOT EXISTS calendar_day_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_date DATE NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_calendar_day_notes_user_date UNIQUE (user_id, note_date),
    CONSTRAINT ck_calendar_day_notes_body_length CHECK (char_length(body) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_calendar_day_notes_user_date
    ON calendar_day_notes(user_id, note_date);

ALTER TABLE calendar_day_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_day_notes_isolation ON calendar_day_notes;
CREATE POLICY calendar_day_notes_isolation ON calendar_day_notes
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
