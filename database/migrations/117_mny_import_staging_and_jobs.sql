-- Native Microsoft Money (.mny) import, task M1.1: server-side staging for the
-- uploaded file and a job row for the background import.
--
-- Why the bytes live in the database rather than on the pod's disk: with more
-- than one backend replica the /import/mny/start call can land on a different
-- pod than the upload that produced the staged file, so the database is the only
-- store both can reach. See docs/specs/mny-import.md, ADR-2.
--
-- The staged bytes are the DECRYPTED Money file. The user's Money password is a
-- request-scoped multipart field on the parse call and is never persisted, so a
-- staged row cannot leak it. Rows are deleted when the import completes and
-- swept by a TTL cron (ADR-2), which is why expires_at is NOT NULL.

CREATE TABLE IF NOT EXISTS import_staged_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    source_format VARCHAR(20) NOT NULL DEFAULT 'mny', -- room for future binary importers
    size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL, -- hex digest of the staged bytes (integrity + retry identity)
    data BYTEA NOT NULL, -- the decrypted file; re-parsed on import rather than serialized
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_staged_files_user
    ON import_staged_files(user_id);
-- Drives the TTL sweep, which scans by expiry across all users.
CREATE INDEX IF NOT EXISTS idx_import_staged_files_expires
    ON import_staged_files(expires_at);

-- One row per import attempt. `status` moves pending -> running -> completed |
-- failed; a failed row keeps its staged file so Retry is a new job over the same
-- bytes. `progress` is written in its own short transaction by the running job
-- (a write inside the import transaction would be invisible to the wizard's
-- poll), and `heartbeat_at` is what the reaper cron uses to tell a live job from
-- one whose pod died.
CREATE TABLE IF NOT EXISTS import_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SET NULL rather than CASCADE: a completed job's report outlives the bytes
    -- it was produced from, and the TTL sweep must not delete import history.
    staged_file_id UUID REFERENCES import_staged_files(id) ON DELETE SET NULL,
    source_format VARCHAR(20) NOT NULL DEFAULT 'mny',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed'
    options JSONB NOT NULL DEFAULT '{}'::jsonb, -- the wizard's import options, as sent
    progress JSONB, -- { phase, processed, total } while running
    result JSONB, -- counts + verification report once completed
    error_key VARCHAR(100), -- i18n key for a failed job, never a raw message
    error_detail TEXT, -- untranslated diagnostic for the log/report
    retryable BOOLEAN NOT NULL DEFAULT false,
    heartbeat_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_staged_file ON import_jobs(staged_file_id);
-- Partial: the reaper only ever looks at jobs that are still claimed as running.
CREATE INDEX IF NOT EXISTS idx_import_jobs_running_heartbeat
    ON import_jobs(heartbeat_at)
    WHERE status = 'running';

DROP TRIGGER IF EXISTS update_import_jobs_updated_at ON import_jobs;
CREATE TRIGGER update_import_jobs_updated_at
    BEFORE UPDATE ON import_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Row-Level Security: both tables carry their own user_id, so they take the
-- Group A predicate from migration 112 verbatim. Inert until the enabling
-- migration runs, exactly like every other policy in the ratchet.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS import_staged_files_isolation ON import_staged_files;
CREATE POLICY import_staged_files_isolation ON import_staged_files
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS import_jobs_isolation ON import_jobs;
CREATE POLICY import_jobs_isolation ON import_jobs
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
