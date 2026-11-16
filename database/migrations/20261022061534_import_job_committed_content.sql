-- The bytes a committed MNY import consumed, held by a unique index, so the same
-- file cannot be imported into the same user's ledger twice (audit A26-H08,
-- INV-IMPORT-002).
--
-- `data_committed` (migration 140) tells a committed run from a run that wrote
-- nothing, and the reaper and `fail()` refuse Retry on it. It says nothing about
-- the *next* start: a new job over the same staged id, or over a re-upload of the
-- same file under a new staged id, imported every row a second time under fresh
-- UUIDs, doubling every balance and holding.
--
-- `content_sha256` is the staged file's digest, copied onto the job by the commit
-- checkpoint (`markDataCommitted`) inside the import transaction, so it commits
-- with the rows it vouches for. `MnyImportJobService.create` refuses a start over
-- bytes a job already holds, under the `UserImport` advisory lock; the unique
-- index is the backstop that makes a second commit of the same bytes abort its
-- own transaction rather than land. A start that replaces the user's data
-- ("start fresh") releases the keys once its wipe succeeded, because the rows
-- they vouched for are gone.
--
-- Expand-only: a nullable column a previous-release binary never writes, and an
-- index whose predicate excludes every row that binary produces.
--
-- The backfill keys the committed jobs whose staged file still exists (a run that
-- failed after its commit keeps its bytes); a completed job's bytes were deleted
-- on completion, so there is nothing to key it on. Where several committed jobs
-- share one digest (the duplicate imports this migration exists to stop) the
-- newest one takes the key, so the index can be built.

ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64);

UPDATE import_jobs j
   SET content_sha256 = keyed.sha256
  FROM (
        SELECT DISTINCT ON (job.user_id, file.sha256) job.id, file.sha256
          FROM import_jobs job
          JOIN import_staged_files file ON file.id = job.staged_file_id
         WHERE job.data_committed
         ORDER BY job.user_id, file.sha256, job.created_at DESC, job.id
       ) keyed
 WHERE j.id = keyed.id
   AND j.content_sha256 IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM import_jobs other
          WHERE other.user_id = j.user_id
            AND other.content_sha256 = keyed.sha256
       );

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_jobs_committed_content
    ON import_jobs(user_id, content_sha256)
    WHERE content_sha256 IS NOT NULL;
