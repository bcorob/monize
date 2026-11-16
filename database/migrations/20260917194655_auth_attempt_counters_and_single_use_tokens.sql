-- Two tables that move authentication state out of process memory, so a
-- lockout, a rate limit and a one-shot code mean the same thing on every
-- replica and survive a restart. Nothing reads them yet; the services that
-- replace the in-memory Maps follow (horizontal-scaling tasks A2, A3, A4, X1).
--
-- Both are RLS-exempt and both are keyed by an opaque string on purpose: they
-- are written on the *failure* path, before any identity is established -- a
-- wrong 2FA code, a forgot-password request for an address that may not exist
-- -- so there is no user to policy on and adding one would leak the
-- association. The keys are hashes (an email hash, a temp-token hash,
-- hash(userId:code)), which is what keeps a table readable by every session
-- from being a directory of who tried to log in.
--
-- The window semantics live in the INSERT ... ON CONFLICT the service issues,
-- not here: `count` and `window_expires_at` are written together in one
-- statement so two concurrent failures cannot lose an increment
-- (docs/concurrency-and-idempotency.md, mechanism 1). This migration only
-- provides the row to write.

CREATE TABLE IF NOT EXISTS auth_attempt_counters (
    -- Which limiter this counter belongs to, e.g. `2fa-user`, `forgot-password`.
    -- Spelled out by the service so a typo is a new limiter, never a shared one.
    scope TEXT NOT NULL,
    -- Opaque subject within that scope: a hash, or an id the caller already has.
    key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    -- When the current window ends. A row past this is not deleted on read:
    -- the incrementing statement resets it to 1 in place, and the sweep below
    -- collects it later.
    window_expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_auth_attempt_counters_expiry
    ON auth_attempt_counters(window_expires_at);

CREATE TABLE IF NOT EXISTS single_use_tokens (
    -- What kind of one-shot this is, e.g. `totp`, `ai-action`.
    purpose TEXT NOT NULL,
    -- SHA-256 of the secret. Never the secret: a table with no owner column is
    -- readable by every session, so what it holds must not be replayable.
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (purpose, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_single_use_tokens_expiry
    ON single_use_tokens(expires_at);
