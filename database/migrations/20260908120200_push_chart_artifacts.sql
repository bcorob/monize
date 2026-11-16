-- Ephemeral bearer-authorized images, shared across replicas and never backed up.
-- rls-exempt: push_chart_artifacts
CREATE TABLE IF NOT EXISTS push_chart_artifacts (
    id VARCHAR(64) PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    png BYTEA NOT NULL CHECK (octet_length(png) <= 65536)
);
CREATE INDEX IF NOT EXISTS idx_push_chart_artifacts_expiry ON push_chart_artifacts(expires_at);
