-- The AI review queue: a durable request that an AI look at one transaction,
-- produced by a rule's `request_ai_review` action
-- (docs/future-plans/transaction-rules.md section 6.5, task R1).
--
-- Pure expand: one new table, nothing existing is altered, so the previous
-- release keeps working against this schema during a rolling deploy.
--
-- Life of a row: pending -> claimed -> proposed -> applied | rejected, and
-- expired from any state that is not yet terminal. The CHECK is the state
-- machine's vocabulary; the transitions are conditional UPDATEs where the loser
-- gets zero rows. A request carries the instruction and the transaction id, not
-- a copy of the row. `proposal` holds the signed pending action an agent
-- submitted; nothing is ever written to the ledger from this table.
--
-- Dedupe: at most one open (pending, claimed or proposed) request per
-- (transaction_id, rule_id), so re-importing a file or re-running a rule does
-- not queue the same question twice. rule_id is nullable (ON DELETE SET NULL,
-- and a manual request has no rule); NULLs are distinct in a unique index, so
-- such rows are deliberately not deduplicated here. NULLS NOT DISTINCT would
-- make deleting a rule fail on a second open request against one transaction.
--
-- Defaults on kind, status and expires_at are deliberate: the RLS enforcement
-- spec's generic row seeder invents a `t<n>` string for a varchar column with no
-- default, which the enumerated CHECKs below would reject. The application
-- always writes kind, status and instruction explicitly.
--
-- User-owned: the ordinary direct policy, and the enable in this file
-- (database/CLAUDE.md, Row-level security rule 1).

CREATE TABLE IF NOT EXISTS ai_review_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    rule_id UUID REFERENCES transaction_rules(id) ON DELETE SET NULL,
    kind VARCHAR(40) NOT NULL DEFAULT 'transaction_review',
    instruction TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    claimed_by TEXT,
    claimed_at TIMESTAMPTZ,
    proposal JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days',
    CONSTRAINT ck_ai_review_requests_kind
      CHECK (kind IN ('transaction_review')),
    CONSTRAINT ck_ai_review_requests_instruction_length
      CHECK (char_length(instruction) BETWEEN 1 AND 1000),
    CONSTRAINT ck_ai_review_requests_status
      CHECK (status IN ('pending', 'claimed', 'proposed', 'applied', 'rejected', 'expired'))
);

-- The claim query: a user's oldest pending request.
CREATE INDEX IF NOT EXISTS idx_ai_review_requests_claim
    ON ai_review_requests(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_review_requests_transaction
    ON ai_review_requests(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ai_review_requests_rule
    ON ai_review_requests(rule_id) WHERE rule_id IS NOT NULL;
-- The expiry sweep.
CREATE INDEX IF NOT EXISTS idx_ai_review_requests_expiry
    ON ai_review_requests(expires_at) WHERE status IN ('pending', 'claimed', 'proposed');

-- The dedupe: one open request per transaction and rule.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_requests_open
    ON ai_review_requests(transaction_id, rule_id)
    WHERE status IN ('pending', 'claimed', 'proposed');

-- The touch trigger every sibling table with an updated_at column has.
DROP TRIGGER IF EXISTS update_ai_review_requests_updated_at ON ai_review_requests;
CREATE TRIGGER update_ai_review_requests_updated_at
  BEFORE UPDATE ON ai_review_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_review_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_review_requests_isolation ON ai_review_requests;
CREATE POLICY ai_review_requests_isolation ON ai_review_requests
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
