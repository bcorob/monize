-- Account-level defaults for the browser-local view settings (row density, the
-- register's year display, the Transactions page's widgets and chart) plus
-- where opening an account goes. A browser that has saved its own choice keeps
-- it; these apply only where the browser has nothing saved. Empty object = no
-- defaults set, so every surface uses its built-in default.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS view_defaults JSONB NOT NULL DEFAULT '{}';
