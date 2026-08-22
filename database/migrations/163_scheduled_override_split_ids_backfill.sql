-- 163: Backfill a stable id into every occurrence-override investment split
--
-- Override splits are stored inside the `scheduled_transaction_overrides.splits`
-- jsonb array. Issue #1167 F4 gave each override split a server-generated `id`
-- so the UI can echo it as `sourceSplitId` on edit and the server decides FX-rate
-- provenance by stable identity. Rows written before that change have no `id`.
--
-- Without a real id the editor falls back to a synthetic React key (`override-N`),
-- which the DTO's `@IsUUID` rejects (HTTP 400) -- so a pre-existing split override
-- became uneditable after deploy (issue #1167 R8-F1) -- and, absent identity, the
-- server cannot tell a resent legacy line from a genuinely new one. This assigns
-- identity ONLY: `id` is a fresh UUID, and no FX provenance is inferred (the pair
-- stays whatever the row already had -- unset for a legacy row -- so posting still
-- re-resolves it, never re-blessing a stale scalar, R8-F2).
--
-- Idempotent: only rows with at least one id-less split element are rewritten, so
-- a replay on an already-backfilled database updates nothing.

UPDATE scheduled_transaction_overrides o
SET splits = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ? 'id' THEN elem
      ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(o.splits) WITH ORDINALITY AS t(elem, ord)
)
WHERE o.splits IS NOT NULL
  AND jsonb_typeof(o.splits) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(o.splits) AS e
    WHERE NOT (e ? 'id')
  );
