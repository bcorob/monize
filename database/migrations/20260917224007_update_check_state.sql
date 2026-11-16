-- The upstream release check's answer, as one row.
--
-- The check lived in a field on `UpdatesService`, which made two things false
-- at once: two replicas answer `/updates` from two caches, so the same person
-- sees "update available" or not depending on which pod served them, and a
-- restart throws the answer away and re-asks GitHub -- whose unauthenticated
-- rate limit is per IP, shared by every replica behind one egress address.
--
-- The row is also the claim. The refresh stamps `checked_at` only when the
-- stored one is older than the window, and only the statement that stamped it
-- goes on to call GitHub -- so N replicas ticking together make one request,
-- not N.
--
-- Singleton, like push_instance_config: one deployment checks one upstream.
--
-- Deployment-wide state with no owner column, so RLS-exempt; see the marker
-- block at the foot of database/schema.sql and
-- docs/row-level-security-contract.md.
--
-- rls-exempt: update_check_state

CREATE TABLE IF NOT EXISTS update_check_state (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- When GitHub was last ASKED, not when it last answered usefully: a failed
    -- check must still hold the window, or an unreachable provider turns every
    -- tick on every replica into another request.
    checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    latest_version TEXT,
    release_url TEXT,
    release_name TEXT,
    published_at TIMESTAMPTZ,
    last_error TEXT
);
