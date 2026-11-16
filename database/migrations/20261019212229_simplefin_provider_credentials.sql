-- Add SimpleFIN credentials and owner-scoped request reservations without changing existing Enable Banking rows.
ALTER TABLE bank_sync_credentials ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE bank_sync_credentials ALTER COLUMN private_key_enc DROP NOT NULL;
ALTER TABLE bank_sync_credentials ADD COLUMN IF NOT EXISTS access_url_enc TEXT;
ALTER TABLE bank_sync_credentials DROP CONSTRAINT IF EXISTS ck_bank_sync_credentials_provider;
ALTER TABLE bank_sync_credentials ADD CONSTRAINT ck_bank_sync_credentials_provider CHECK (provider IN ('enable_banking', 'simplefin'));
ALTER TABLE bank_sync_connections DROP CONSTRAINT IF EXISTS ck_bank_sync_connections_provider;
ALTER TABLE bank_sync_connections ADD CONSTRAINT ck_bank_sync_connections_provider CHECK (provider IN ('enable_banking', 'simplefin'));
ALTER TABLE bank_sync_credentials DROP CONSTRAINT IF EXISTS ck_bank_sync_credentials_shape;
ALTER TABLE bank_sync_credentials ADD CONSTRAINT ck_bank_sync_credentials_shape CHECK ((provider = 'enable_banking' AND application_id IS NOT NULL AND private_key_enc IS NOT NULL AND access_url_enc IS NULL) OR (provider = 'simplefin' AND application_id IS NULL AND private_key_enc IS NULL AND access_url_enc IS NOT NULL));
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_bank_sync_credentials_id_user' AND conrelid = 'bank_sync_credentials'::regclass) THEN
        ALTER TABLE bank_sync_credentials ADD CONSTRAINT uq_bank_sync_credentials_id_user UNIQUE (id, user_id);
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS bank_sync_provider_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id UUID NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bank_sync_provider_requests_credential_owner
      FOREIGN KEY (credential_id, user_id) REFERENCES bank_sync_credentials(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bank_sync_provider_requests_window
    ON bank_sync_provider_requests(credential_id, requested_at);

DROP POLICY IF EXISTS bank_sync_provider_requests_isolation ON bank_sync_provider_requests;
CREATE POLICY bank_sync_provider_requests_isolation ON bank_sync_provider_requests
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
ALTER TABLE bank_sync_provider_requests ENABLE ROW LEVEL SECURITY;
