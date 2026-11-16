-- fetch_sync.progress: what the holder of a lease reports while it works, so a
-- person waiting on a bond program's Refresh can see real progress instead of
-- a spinner (docs/specs/bond-program-securities.md 2.5). camelCase JSON:
-- { startedAt, phase: offer | series | done, done, total, seriesCode,
-- finishedAt }. Written by FetchSyncService.reportProgress, only by the holder
-- of the lease token; NULL for every job that reports nothing. Nullable and
-- additive, so the previous release keeps working against it.
ALTER TABLE fetch_sync ADD COLUMN IF NOT EXISTS progress JSONB;
