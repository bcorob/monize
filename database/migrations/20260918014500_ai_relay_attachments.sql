-- Relay attachment metadata and bytes, so a file a user uploads with a chat
-- prompt is readable by their agent from any replica.
--
-- Both lived in a per-process Map in
-- backend/src/ai/relay/relay-attachment.store.ts, which made the reverse relay
-- a single-process feature in the one place it is least obvious: the browser
-- uploads to whichever replica served the POST, and the agent then reads the
-- monize-attachment:// resource through whichever replica served its MCP
-- request. Two different pods, and the read finds nothing.
--
-- These are NOT routed through ATTACHMENT_STORAGE_PROVIDER, which the design
-- note proposed. That provider's `database` implementation writes
-- attachment_blobs, whose primary key is a foreign key to
-- transaction_attachments and whose RLS policy reads the owner from that same
-- row -- so a relay attachment, which has no transaction and no attachment row,
-- cannot be stored there at all. The alternative was branching on the bound
-- provider's name, which is the generic solution that looks fine in isolation
-- and wrong in place.
--
-- A table pair mirroring transaction_attachments/attachment_blobs is the
-- pattern that fits: metadata queries never touch BYTEA, bytes and metadata
-- commit or roll back together (no bytes-before-commit window at all, unlike
-- the local and S3 attachment paths), and the cascade reclaims the bytes with
-- the row -- so the relay sweep deletes rows and nothing outside PostgreSQL is
-- left to leak. Relay attachments are scratch: at most a few megabytes, for at
-- most twenty minutes, deleted as soon as the prompt settles.
--
-- User-owned, so the ordinary direct policy on the parent and the parent-owned
-- policy on the blobs: a delegate reading someone's accounts has no business
-- reading the file they attached to their own chat.

CREATE TABLE IF NOT EXISTS ai_relay_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    -- How the MCP resource must return the file: extracted text, a base64
    -- blob, or a PDF that tries text first. Defaulted, like
    -- security_documents.document_type, for the same reason: the RLS
    -- enforcement spec's generic seeder invents a `t<n>` string for a NOT NULL
    -- text column with no default, which no CHECK-constrained column can
    -- accept. `text` is the branch that needs no special handling.
    kind TEXT NOT NULL DEFAULT 'text',
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Outlives the longest a prompt can stay in flight, so the agent can still
    -- read the file right up to the moment the browser gives up.
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_ai_relay_attachments_kind
      CHECK (kind IN ('image', 'pdf', 'text'))
);

-- The sweep's keyset.
CREATE INDEX IF NOT EXISTS idx_ai_relay_attachments_expiry
    ON ai_relay_attachments(expires_at);

-- The bytes, in their own table so the metadata lookups never read BYTEA --
-- the same split attachment_blobs makes, for the same reason.
CREATE TABLE IF NOT EXISTS ai_relay_attachment_blobs (
    attachment_id UUID PRIMARY KEY
        REFERENCES ai_relay_attachments(id) ON DELETE CASCADE,
    data BYTEA NOT NULL
);

ALTER TABLE ai_relay_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_relay_attachment_blobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_relay_attachments_isolation ON ai_relay_attachments;
CREATE POLICY ai_relay_attachments_isolation ON ai_relay_attachments
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ai_relay_attachment_blobs -> ai_relay_attachments.user_id, the shape
-- attachment_blobs uses over transaction_attachments.
DROP POLICY IF EXISTS ai_relay_attachment_blobs_isolation
    ON ai_relay_attachment_blobs;
CREATE POLICY ai_relay_attachment_blobs_isolation ON ai_relay_attachment_blobs
    USING ((SELECT app_bypass_rls()) OR EXISTS (
        SELECT 1 FROM ai_relay_attachments a
        WHERE a.id = ai_relay_attachment_blobs.attachment_id
          AND a.user_id = (SELECT app_current_user_id())))
    WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
        SELECT 1 FROM ai_relay_attachments a
        WHERE a.id = ai_relay_attachment_blobs.attachment_id
          AND a.user_id = (SELECT app_current_user_id())));
