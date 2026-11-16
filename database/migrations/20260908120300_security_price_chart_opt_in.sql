-- Charts require explicit opt-in for each instrument (collapse group).
ALTER TABLE securities ADD COLUMN IF NOT EXISTS price_chart_enabled BOOLEAN NOT NULL DEFAULT FALSE;
