-- Brand icons for payees, mirroring institutions (migration 082).
--
-- The icon is the payee website's favicon, resolved server-side through the
-- shared favicon fetcher and cached in logo_data, so the user's browser never
-- contacts a third party to render it. has_logo is what list reads answer
-- "is there an icon?" with, because the bytes are never selected by default;
-- logo_fetched_at stamps the last attempt, successful or not.

ALTER TABLE payees ADD COLUMN IF NOT EXISTS logo_data BYTEA;
ALTER TABLE payees ADD COLUMN IF NOT EXISTS logo_content_type VARCHAR(100);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS has_logo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payees ADD COLUMN IF NOT EXISTS logo_fetched_at TIMESTAMP;
