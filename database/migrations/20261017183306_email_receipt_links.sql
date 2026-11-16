-- Linked email receipts (docs/specs/email-receipt-linked-receipts.md): a
-- repayment email (a settlement) names one bank transaction, and each of its
-- parts pays for a purchase email (a component) that holds the item detail. The
-- two share a link value per purchase.
--
-- email_receipts.link_key is the link value of a receipt whose status is
-- `component`; null for every other receipt. The status CHECK gains `component`:
-- a stored purchase email that never looks for a bank transaction.
--
-- email_receipt_links holds one row per part of a settlement receipt: the part's
-- link value and amount, the component it joined (set only for `joined` and
-- `scaled`; SET NULL when that email is deleted) and what the part became. The
-- rows of a settlement are replaced in the transaction that stores its new
-- state; a deleted settlement takes its rows with it (CASCADE). The defaults on
-- part_index and outcome exist for the RLS spec's generic row seeder.
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: the new column is nullable, the status CHECK only widens and
-- the new table is read by no earlier code.

ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS link_key VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_email_receipts_link_key
    ON email_receipts(user_id, link_key) WHERE link_key IS NOT NULL;

ALTER TABLE email_receipts DROP CONSTRAINT IF EXISTS ck_email_receipts_status;
ALTER TABLE email_receipts
    ADD CONSTRAINT ck_email_receipts_status
    CHECK (status IN ('pending', 'skipped', 'no_parser', 'parse_failed',
                      'unmatched', 'ambiguous', 'review_conflict', 'review',
                      'ignored', 'component'));

CREATE TABLE IF NOT EXISTS email_receipt_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    settlement_receipt_id UUID NOT NULL REFERENCES email_receipts(id) ON DELETE CASCADE,
    part_index INTEGER NOT NULL DEFAULT 0,
    link_value VARCHAR(100),
    part_amount NUMERIC(20,4) NOT NULL,
    component_receipt_id UUID REFERENCES email_receipts(id) ON DELETE SET NULL,
    outcome VARCHAR(30) NOT NULL DEFAULT 'no_link',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_email_receipt_links_part UNIQUE (settlement_receipt_id, part_index),
    CONSTRAINT ck_email_receipt_links_part_index
      CHECK (part_index BETWEEN 0 AND 99),
    CONSTRAINT ck_email_receipt_links_part_amount
      CHECK (part_amount >= 0),
    CONSTRAINT ck_email_receipt_links_outcome
      CHECK (outcome IN ('no_link', 'not_found', 'component_incomplete',
                         'component_used', 'joined', 'scaled', 'amount_exceeds'))
);

-- A component that arrives after its settlement finds the parts waiting for it;
-- `taken` sums the parts that already used a component.
CREATE INDEX IF NOT EXISTS idx_email_receipt_links_waiting
    ON email_receipt_links(user_id, link_value)
    WHERE component_receipt_id IS NULL AND link_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_receipt_links_component
    ON email_receipt_links(component_receipt_id) WHERE component_receipt_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_email_receipt_links_updated_at ON email_receipt_links;
CREATE TRIGGER update_email_receipt_links_updated_at
  BEFORE UPDATE ON email_receipt_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE email_receipt_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_receipt_links_isolation ON email_receipt_links;
CREATE POLICY email_receipt_links_isolation ON email_receipt_links
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
