-- The AI relay's queue, its agent liveness and its buffered write-confirmation
-- cards, as rows. Nothing reads these yet: tasks R3, R4 and R5 move
-- `ai-relay.service.ts` off the Maps it holds today.
--
-- Why rows at all. The relay brokers between a browser holding an SSE stream
-- and the user's own MCP agent long-polling for work. Every piece of that
-- handshake currently lives in process memory, which makes two separate
-- promises false: a second replica serving the agent's poll cannot see a prompt
-- the first replica queued, and a restart between "enqueued" and "answered"
-- loses the turn with nothing able to notice.
--
-- All three are user-owned and take the ordinary direct policy: the relay is
-- the authenticated user driving their own chat through their own agent, with
-- no delegate arm -- a delegate reading someone's accounts has no business
-- claiming their prompts.

CREATE TABLE IF NOT EXISTS ai_relay_prompts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- pending -> claimed -> answered, or expired from either of the first two.
    -- The CHECK is the whole of the state machine's vocabulary; the transitions
    -- are conditional UPDATEs in the service, where the loser gets zero rows.
    -- Born pending: the default is the initial state, not a convenience.
    status TEXT NOT NULL DEFAULT 'pending',
    -- The turn as the agent receives it: prompt text, prior history, attachment
    -- refs. JSONB rather than columns because the agent-facing shape is a
    -- payload the MCP tool hands over whole, not something SQL ever filters on.
    prompt JSONB NOT NULL,
    answer JSONB,
    -- The MCP session that claimed this turn. A relay turn belongs to ONE
    -- session: liveness and writes from another session the same user has open
    -- are not part of it and must not steer it.
    claimed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_ai_relay_prompts_status
      CHECK (status IN ('pending', 'claimed', 'answered', 'expired'))
);

-- The claim's index: one user's oldest pending row, which is exactly the
-- keyset the FOR UPDATE SKIP LOCKED claim scans.
CREATE INDEX IF NOT EXISTS idx_ai_relay_prompts_claim
    ON ai_relay_prompts(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_relay_prompts_expiry
    ON ai_relay_prompts(expires_at);

-- One row per user whose agent has ever polled. Progress, not business data:
-- the columns say whether the tunnel indicator reads offline, listening or
-- busy, and nothing financial reads them.
CREATE TABLE IF NOT EXISTS ai_relay_agents (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_poll_at TIMESTAMPTZ,
    -- When the current no-prompt streak began, set on the first empty poll and
    -- cleared by any prompt. Drives the inactivity disconnect.
    idle_since TIMESTAMPTZ,
    -- When the agent was last told to stop for inactivity. The chat shows the
    -- notice until the agent polls again or the user sends a prompt.
    idle_disconnected_at TIMESTAMPTZ
);

-- Write-confirmation cards composed after the browser's stream gave up. The
-- card is still approvable when the browser comes back, which is the whole
-- point: an action the agent decided on must not be silently lost because a
-- socket closed first.
CREATE TABLE IF NOT EXISTS ai_relay_actions (
    -- The action id the agent minted. Text, not UUID: it is the descriptor's
    -- own id and this table does not get to choose its grammar.
    id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    -- Owner first: the pickup endpoint drains by user, and an action id is only
    -- unique within the user who owns it.
    PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ai_relay_actions_expiry
    ON ai_relay_actions(expires_at);

ALTER TABLE ai_relay_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_relay_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_relay_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_relay_prompts_isolation ON ai_relay_prompts;
CREATE POLICY ai_relay_prompts_isolation ON ai_relay_prompts
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS ai_relay_agents_isolation ON ai_relay_agents;
CREATE POLICY ai_relay_agents_isolation ON ai_relay_agents
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS ai_relay_actions_isolation ON ai_relay_actions;
CREATE POLICY ai_relay_actions_isolation ON ai_relay_actions
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
