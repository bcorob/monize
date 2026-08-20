# System Invariants

The conditions that must hold regardless of which controller, service, cron,
importer, provider or form is involved. An invariant here is a claim about the
system as a whole, so it cannot be satisfied by one call site behaving
correctly -- which is the failure mode this catalog exists to prevent. Several
of the entries below were broken by a change that was locally reasonable and
globally wrong, and the reviewer had no document to check it against.

**Status is stated honestly.** An invariant marked `enforced` has a mechanism
named in its entry. One marked `unenforced` describes a condition the system
currently violates, with the violation cited. This catalog is not a description
of the code; it is the target the code is measured against, and the gap is the
useful part. Nothing here is closed by editing this file.

How the statuses are used:

| Status | Meaning |
| --- | --- |
| `enforced` | A named mechanism makes the violation fail. Cite it in reviews. |
| `partial` | Some paths enforce it, others do not. The unenforced paths are listed. |
| `unenforced` | The system can violate this today. |

## Field template

Each entry carries these fields. Where a field says `--`, it is genuinely not
applicable, not merely unknown.

```text
Statement           what must always be true
Source of truth     the row, ledger, provider object or job state that decides
Enforcement         constraint, index, lock, CAS, claim, allowlist, or "none"
Concurrency scope   account, user, holding, occurrence, token, provider key, global
Retry semantics     which retries are safe, and what prevents duplication
Crash semantics     expected state before commit, after commit, mid-finalization
Failure response    409, 404, null, reconcile, refuse, partial
Required tests      per docs/verification-contract.md
Status              enforced | partial | unenforced
```

Two fields a reader might expect are deliberately absent. **CI owner** lives in
`docs/verification-contract.md` section 4 instead, so the job names appear once
rather than in thirty entries that would drift independently of the workflow.
**Subsystem owner** is omitted because this project does not have per-subsystem
owners; adding a column that would read "maintainer" throughout would be
ceremony. Reinstate either the moment it would carry real information.

An entry states only what has been checked. Where a field would require a claim
that was not verified against the source, it says so in the field rather than
guessing. Several entries also name a gold-standard test still owed (a
two-connection race, a two-instance cron) even where the mechanism is enforced:
the mechanism is cited as present, and the missing proof is stated rather than
implied.

## Index

| ID | Invariant | Status |
| --- | --- | --- |
| INV-IMPORT-001 | At most one pending or running MNY import per user | enforced |
| INV-IMPORT-002 | A retry never double-imports | enforced |
| INV-IMPORT-003 | A category collision does not abort an import | unenforced |
| INV-BALANCE-001 | `current_balance` equals opening balance plus included ledger rows | enforced |
| INV-HOLDING-001 | A holding equals a deterministic replay of the investment ledger | enforced |
| INV-HOLDING-002 | Every view replays the ledger the same way | enforced |
| INV-TRANSFER-001 | A transfer's two legs share the VOID boundary and one balance decision | enforced |
| INV-REDEEM-001 | A redemption's accrued interest moves cash once and is income once | enforced |
| INV-RECONCILE-001 | While the strict lock is on, a reconciled transaction is not altered | enforced |
| INV-FX-001 | An unavailable rate never becomes 1:1 | enforced |
| INV-OCCURRENCE-001 | One scheduled occurrence has at most one financial effect | enforced |
| INV-OCCURRENCE-002 | A stored override price survives reopening | enforced |
| INV-CLAIM-001 | An emergency-access claim token is consumed exactly once | enforced |
| INV-AUTH-001 | A refresh token rotates once, or the family is revoked | enforced |
| INV-AUTH-002 | A failed-login counter records every failure | enforced |
| INV-AUTH-003 | A destructive OIDC action requires a provider round trip | enforced |
| INV-AUTH-004 | A logout reports only what it achieved | enforced |
| INV-ACTIVITY-001 | Activity is attributed to whoever acted, not to whoever was acted for | enforced |
| INV-PROFILE-001 | A user-profile response is an allowlist | enforced |
| INV-MCP-001 | An MCP session is bound to the credential that opened it | enforced |
| INV-CURRENCY-001 | A shared currency is deleted only by its creator, on a global count | enforced |
| INV-ATTACHMENT-001 | Available metadata resolves to committed bytes | enforced |
| INV-BACKUP-001 | A backup file is complete, verified and owner-namespaced | enforced |
| INV-CRON-001 | One logical cron effect per schedule tick, across replicas | partial |
| INV-RLS-001 | Enforced mode refuses to run on a role that can bypass RLS | enforced |
| INV-CACHE-001 | A money-moving write invalidates every derived cache | enforced |
| INV-RELEASE-001 | The tested, imaged and tagged revisions are one revision | partial |

## Imports

### INV-IMPORT-001 -- at most one pending or running MNY import per user

```text
Statement           For one user, at most one import job may be pending or running.
Source of truth     import_jobs.status
Enforcement         Partial unique index idx_import_jobs_one_active_per_user on
                    import_jobs(user_id) WHERE status IN ('pending','running'),
                    added by database/migrations/135_import_jobs_single_active.sql.
                    The service's hasActiveJob() pre-check is advisory only and
                    is commented as such; isActiveJobConflict() translates
                    SQLSTATE 23505 into the same 409.
Concurrency scope   per user
Retry semantics     A retry after failure is a new job row; safe.
Crash semantics     A crashed worker leaves status='running' with a stale
                    heartbeat; reapStaleJobs fails it retryably after 5 minutes.
Failure response    409 Conflict
Required tests      Two-connection: two concurrent starts, one winner. Present in
                    backend/test/integration/mny-import-job.integration.spec.ts
                    ("has exactly one winner when two starts race over the same
                    staged file", "has one winner across four concurrent starts",
                    "lets two users start imports concurrently").
Status              enforced
```

This is the reference implementation for the whole catalog. The migration's own
comment explains why the constraint rather than the check: the service counted
active jobs and inserted in a second transaction, so two overlapping starts both
saw zero, and because each parse pre-generates fresh transaction UUIDs nothing
downstream deduplicated the second run. With `wipeExistingData` both requests
could also reach the destructive wipe.

### INV-IMPORT-002 -- a retry never double-imports

```text
Statement           Retrying a failed import must not insert a second copy of
                    rows a previous attempt may have committed.
Source of truth     import_jobs.data_committed and import_jobs.attempt_token,
                    written in writeAll's own transaction
Enforcement         A durable commit checkpoint claimed under an attempt fence.
                    import_jobs.data_committed (migration 140) is set by
                    markDataCommitted as the LAST statement of writeAll's
                    transaction (mny-import.service.ts, mny-import-job.service.ts),
                    a fenced compare-and-set WHERE status='running' AND
                    attempt_token=$n -- so a zero-row result throws and rolls the
                    rows back with it. attempt_token (migration 144) gives each
                    claim an identity a reaped-and-reclaimed job cannot forge, and
                    migration 145's reject_unfenced_import_checkpoint trigger
                    refuses a false->true data_committed on a non-running job from
                    either binary during a rolling deploy. fail() ANDs the caller's
                    retryable with data_committed = false, and the reaper marks a
                    committed stalled job non-retryable, so a committed run is
                    finalized rather than replayed.
Concurrency scope   per user, per attempt
Retry semantics     Safe. A failure inside writeAll rolled everything back; a
                    committed run is recognised by data_committed and refused a
                    replay.
Crash semantics     A crash after writeAll commits leaves data_committed=true, so
                    the reaper finalizes rather than re-runs; a crash before it
                    leaves nothing, since the checkpoint is the transaction's last
                    statement.
Failure response    reconcile -- finalize the committed run rather than replay it.
Required tests      Failpoint present: backend/test/integration/mny-import-job.integration.spec.ts
                    commits writeAll then fails before terminal completion, retries,
                    and asserts the checkpoint is refused after a reap, the whole
                    transaction rolls back so nothing is doubled, a legacy
                    previous-release checkpoint is refused, and a retry claims a
                    fresh token while the stale worker is fenced.
Status              enforced
```

This entry was itself marked `enforced` in an earlier revision on the strength of
a source comment ("The whole write is one transaction, so a failure leaves nothing
behind and Retry cannot double-import") that was true of `writeAll` alone and not
of the import, which was not finished when `writeAll` committed. It is now
genuinely enforced, by the mechanism above rather than the comment -- and it
remains the catalog's cautionary tale that a status copied from a comment is not a
verified status. `docs/concurrency-and-idempotency.md` CONC-007 is the rule that a
named mechanism has to cover the scope claimed; the "Deciding a worker is dead"
section of `backend/CLAUDE.md` has the fence in full.

### INV-IMPORT-003 -- a category collision does not abort an import

```text
Statement           A category the import needs, created concurrently by the same
                    user, must not fail the import.
Source of truth     categories
Enforcement         None. import.service.ts does findOne then create/save. A
                    concurrent manual create raises a unique violation that
                    aborts the whole import transaction.
Concurrency scope   per user
Retry semantics     The user must restart the entire import.
Failure response    Currently a 500 losing the whole import; should be adopting
                    the winner's row.
Required tests      Two-connection: manual category create interleaved with an
                    import needing the same category.
Status              unenforced
```

The cost is disproportionate to the cause: an entire `.mny` import is lost
because one category already existed. `INSERT ... ON CONFLICT DO NOTHING
RETURNING id` plus adopting the winner's row is the fix, and per
`docs/financial-calculation-contract.md` section 6 the conflict path must then
re-read rather than reuse the pre-insert snapshot. Note that no unique index
currently covers top-level categories (`parent_id IS NULL`), so closing this
properly needs the index too.

## Ledger and derived values

### INV-BALANCE-001 -- current_balance equals its ledger

```text
Statement           accounts.current_balance equals opening balance plus every
                    included, non-void, non-child ledger transaction up to the
                    applicable date.
Source of truth     transactions, summed; accounts.opening_balance
Enforcement         Every absolute recompute takes the account lock before reading
                    the ledger. lockAccountsForBalanceWrite (common/db/locks.ts,
                    SELECT ... FOR UPDATE, owner-scoped, id-sorted) is taken by
                    recalculateCurrentBalance, the hourly applyDueTransactionBalances,
                    import-post-processing, action-history and net-worth before they
                    recompute, so a delta can no longer commit between a recompute's
                    read and its write. The atomic delta path (updateBalance) is
                    unchanged. A VOID transfer moves neither balance
                    (transaction-transfer.service.ts skips both updateBalance calls).
Concurrency scope   per account
Retry semantics     A recompute is idempotent against another recompute and, under
                    the lock, against a concurrent delta.
Failure response    balances reflect every included non-void non-child row.
Required tests      Source scan: common/db/derived-state-writers.guard.spec.ts --
                    only sanctioned services write current_balance, and each reads
                    under a lock. Two-connection (delta interleaved with a recompute,
                    the delta must survive): backend/test/integration/balance-delta-recompute.integration.spec.ts.
Status              enforced
```

See `docs/concurrency-and-idempotency.md` CONC-003. The former secondary breach --
transfers created as `VOID` moving both balances -- is closed on the create path
too.

### INV-HOLDING-001 -- a holding is a deterministic ledger replay

```text
Statement           holdings.quantity and average_cost equal a deterministic
                    replay of that account's investment ledger.
Source of truth     investment_transactions
Enforcement         Every mutation path takes an account-scoped advisory lock.
                    lockHoldingScope (common/db/locks.ts) is taken by
                    createOrUpdate, updateHolding, applySplit, reverseSplit,
                    adjustQuantity and rebuild -- advisory rather than a row lock
                    because a rebuild must serialize against investment_transactions
                    inserts that no holdings row-lock covers -- so two concurrent
                    trades on one (account, security) cannot lose an update.
                    UNIQUE(account_id, security_id) still prevents duplicate rows.
Concurrency scope   per (account, security)
Retry semantics     Serialized by the lock; a lost update cannot occur.
Failure response    the stored holding equals a deterministic replay of the ledger.
Required tests      Two-connection (concurrent trades on one holding, the stored
                    row compared against the replay):
                    backend/test/integration/holding-concurrent-trades.integration.spec.ts.
Status              enforced
```

### INV-HOLDING-002 -- every view replays the ledger the same way

```text
Statement           Every surface that derives a share count from the investment
                    ledger must apply each action identically.
Source of truth     the shared reducer applyActionToQuantity
Enforcement         One shared reducer, called by every surface.
                    applyActionToQuantity (securities/investment-replay.util.ts)
                    folds each action into the running share count -- multiplying
                    on SPLIT, with SHARE_MOVING_ACTIONS naming the set -- and both
                    holdings.service.ts and net-worth.service.ts (all three of its
                    reducers) call it rather than hand-rolling the fold. The old
                    disagreement (net-worth adding on SPLIT and omitting
                    ADD_SHARES/REMOVE_SHARES) is gone.
Concurrency scope   --
Failure response    The holdings page and the historical net-worth charts report
                    one share count for a position after any split.
Required tests      Source scan: securities/investment-replay.guard.spec.ts fails
                    on any SPLIT branch computing a quantity outside the reducer,
                    a hand-listed disposal set, and a `quantity *=` anywhere.
Status              enforced
```

The arithmetic the reducer centralises: 90 shares at ratio 2.0 is 180, and the
additive form the net-worth reducers once used gave 92. This invariant is separate
from INV-HOLDING-001 on purpose -- that one is about concurrency, this one about
two implementations of the same rule.

### INV-TRANSFER-001 -- both legs, one decision

```text
Statement           A transfer's legs share the VOID boundary, and any balance
                    movement is decided once for the pair. Reconciliation states
                    (PENDING/CLEARED/RECONCILED) are deliberately per-ledger and
                    are not mirrored -- only VOID inclusion is shared.
Source of truth     the two linked transactions rows
Enforcement         The balance decision is made once per pair, keyed on VOID.
                    Creating a VOID transfer moves neither balance
                    (transaction-transfer.service.ts skips both updateBalance
                    calls when status is VOID). A status edit crossing the VOID
                    boundary mirrors the counterpart leg and a split parent's
                    transfer children (applyVoidTransitionToMirrorLeg,
                    applyParentStatusToTransferCounterparts in
                    transaction-reconciliation.service.ts). markCleared / reconcile
                    / unreconcile deliberately do NOT mirror, because a reconcile
                    state is per-ledger. Guards: deletion-balance.guard.spec.ts,
                    investment-void-classification.guard.spec.ts,
                    void-status-transition.util.ts.
Concurrency scope   per transfer pair
Failure response    consistent balances across the pair on every VOID transition.
Required tests      Per status-changing path, both legs' balances stay consistent
                    across a VOID transition, including the split-transfer variant
                    that links through the split parent rather than a mirror leg.
Status              enforced
```

The statement was narrowed on purpose. "Both legs share one status" was too broad:
a reconcile state is genuinely per-ledger (a cross-owner transfer's two ledgers
reconcile independently), and only the VOID boundary -- where money either moved
or did not -- is shared. See `backend/CLAUDE.md`, "Editing one row must not leave
the pair describing two different events".

### INV-REDEEM-001 -- a redemption's accrued interest moves cash once

```text
Statement           A REDEEM carrying accrued interest produces exactly one cash
                    transaction, for proceeds plus interest, and the interest is
                    counted exactly once as interest income.
Source of truth     the REDEEM row and its linked INTEREST companion
Enforcement         disposalCashAmount (securities/accrued-interest.util.ts) is
                    the only place the two are added; the companion is written
                    with transaction_id null, so it can produce no second cash
                    row. accrued-interest.guard.spec.ts fails a hand-rolled
                    addition elsewhere. The companion is created, statused and
                    deleted with the redemption inside one withScopedDb.
Concurrency scope   per redemption pair
Retry semantics     None needed: create, edit and delete each run in one
                    transaction, and the companion has no independent write path.
Crash semantics     Before commit, neither row exists. After commit, both rows
                    and the single cash row exist. There is no mid-state where a
                    companion exists without its redemption.
Failure response    400 before any write for a non-REDEEM action, a negative
                    value, or a row embedded in a split.
Required tests      docs/specs/redemption-accrued-interest.md section 6.
Status              enforced
```

### INV-RECONCILE-001 -- while the strict lock is on, a reconciled transaction is not altered

```text
Statement           While user_preferences.lock_reconciled_transactions is true,
                    no request may change a RECONCILED transaction of that user:
                    not its fields, not its splits, not its existence, and not
                    its status -- unreconciling included, since an escape hatch
                    one click from the row is not a lock. Turning the preference
                    off is the only way through, and that is a deliberate
                    decision about the whole ledger rather than an accident on
                    one row.
Source of truth     transactions.status, read from the row locked by the writing
                    transaction; user_preferences.lock_reconciled_transactions
                    for whether the lock applies.
Enforcement         assertReconciledRowsMutable / assertReconciledIdsMutable
                    (backend/src/transactions/reconciled-lock.util.ts), called
                    inside each mutation's own withScopedDb, after the row lock
                    and before the first write.
                    backend/src/transactions/reconciled-lock.guard.spec.ts
                    enumerates the covered entry points, extracts each method's
                    body and fails when one stops asking -- and separately fails
                    when an assertion sits before its transaction opens.
                    Covered: TransactionsService.update / remove,
                    TransactionReconciliationService.applyStatusTransition (the
                    resolver behind clear / reconcile / unreconcile and
                    PATCH :id/status) and its bulkReconcile,
                    TransactionTransferService.removeTransfer /
                    updateTransfer, TransactionBulkUpdateService.bulkUpdate /
                    bulkDelete, TransactionSplitService.updateSplits / addSplit /
                    removeSplit, ActionHistoryService.undoTransactionUpdate (undo
                    and redo of a transaction edit) and
                    InvestmentTransactionsService.updateEmbeddedSplitParent (the
                    split parent's amount recomputed when an embedded investment
                    row changes). The last two receive an ambient EntityManager
                    rather than opening their own withScopedDb, so the guard scans
                    them with a `beforeWrite` marker -- the assertion must precede
                    the method's first write. The AI assistant, the MCP tools and
                    the joint register reach the ledger through these same methods,
                    so they inherit the refusal rather than needing their own.
                    The backup restore is deliberately exempt: it rewrites the
                      whole ledger under withPreserveTimestamps, and a
                      per-row refusal there would produce a half-restored
                      database, which is worse than the thing the lock prevents.
Concurrency scope   per transaction row, under the same lock as the write
Retry semantics     A refusal is terminal, not retryable: the answer does not
                    change until the user changes the preference. Nothing is
                    written, so a client retry is harmless.
Crash semantics     Not applicable -- the guard writes nothing. A crash before
                    commit rolls back the whole mutation, guard included.
Failure response    409 Conflict, errors.transactions.reconciledLocked
Required tests      Unit: the guard refuses on a reconciled row, allows the same
                    write with the lock off, refuses a mixed set on the strength
                    of one reconciled row, and does not read the preference when
                    no row is reconciled
                    (backend/src/transactions/reconciled-lock.util.spec.ts).
                    Service: a refusal leaves the row and the balance untouched
                    (backend/src/transactions/transaction-reconciliation.service.spec.ts,
                    "the strict reconciled lock"). Source scan: every listed
                    entry point still asks, inside its transaction
                    (backend/src/transactions/reconciled-lock.guard.spec.ts),
                    now including the undo/redo and embedded-investment paths.
                    Still owed: a two-connection test that the refusal holds
                    against a concurrent write.
Status              enforced
```

### INV-FX-001 -- an unavailable rate is not 1:1

```text
Statement           A cross-currency value must never become a valid-looking 1:1
                    value, and an unconverted amount must never be returned under
                    the target currency's label.
Source of truth     exchange_rates
Enforcement         Consumers return null on an absent rate, and accumulate
                    through FxAggregate. net-worth.service.ts convertCurrency
                    returns number | null (the `result ?? amount` fallback is
                    gone); portfolio-calculation.service.ts returns null when
                    neither direct nor reverse rate exists (the `: 1` else-branch
                    is gone). A scanning guard, common/fx-fallback.guard.spec.ts,
                    bans `?? amount` beside a conversion, `rate ... : 1` / `?? 1`,
                    and an unreviewed `1 / reverse` reciprocal, and asserts each
                    reviewed reciprocal returns null when neither direction exists.
Concurrency scope   --
Failure response    null or an explicitly partial figure, per
                    docs/financial-calculation-contract.md section 1.
Required tests      Present: common/fx-fallback.guard.spec.ts (the source scan
                    above) plus the FxAggregate accumulator (common/fx-aggregate.ts)
                    that names each unresolvable pair rather than absorbing it.
Status              enforced
```

At a real rate of 1.3500, a false 100.00 CAD would understate a 135.00 CAD
position by 35.00 and report it as measured -- which is what the null return and
the scan now prevent.

## Scheduled occurrences

### INV-OCCURRENCE-001 -- one occurrence, one effect

```text
Statement           One scheduled occurrence may create at most one financial
                    effect.
Source of truth     scheduled_transaction_postings, one row per occurrence
Enforcement         A durable occurrence key claimed atomically.
                    processAutoPostTransactions locks the schedule and CAS-checks
                    next_due_date is still due, then claims the occurrence with
                    INSERT INTO scheduled_transaction_postings ... ON CONFLICT
                    (scheduled_transaction_id, original_due_date) DO NOTHING
                    RETURNING id (scheduled-transactions.service.ts), throwing
                    ConflictException on a lost claim. The unique index
                    idx_stp_occurrence (schema.sql, migration 140) is the
                    database-level backstop, so exactly-once holds regardless of
                    replica count; the cron treats the ConflictException as
                    "claimed by another replica".
Concurrency scope   per (scheduled transaction, occurrence date)
Retry semantics     Safe: a re-post is refused by the occurrence claim.
Crash semantics     A crash between claim and advance leaves the claim row, so the
                    next tick is refused rather than reposting.
Failure response    the losing claim gets ConflictException, having posted nothing.
Required tests      The unique index gives DB-level exactly-once; a two-instance
                    "two replicas, one posting" integration test is still owed as
                    the gold-standard proof.
Status              enforced
```

This was `docs/concurrency-and-idempotency.md` CONC-004's canonical case -- the
logical operation key `(scheduledTransactionId, occurrenceDate)` that simply was
not persisted -- and it now is, as scheduled_transaction_postings.

### INV-OCCURRENCE-002 -- a stored override price survives

```text
Statement           A stored override price is not replaced by a market quote
                    without an explicit user action.
Source of truth     scheduled_transaction_overrides.investment_price
Enforcement         The market-price auto-fill is gated. OverrideEditorDialog
                    seeds from the stored value and writes the fetched market
                    price only when investmentPrice is empty (frontend
                    scheduled-transactions/OverrideEditorDialog.tsx), so a stored
                    or inherited price is never overwritten by a differing quote.
Concurrency scope   per occurrence
Failure response    a stored ten-at-100.00 stays ten at 100.00 across a reopen.
Required tests      Present: OverrideEditorDialog.test.tsx -- reopen with a stored
                    price and a differing quote asserts the stored price stands,
                    plus the typed-total-before-close case.
Status              enforced
```

## Authentication and authorization

### INV-CLAIM-001 -- a claim token is consumed exactly once

```text
Statement           An emergency-access claim token may be consumed successfully
                    exactly once.
Source of truth     emergency_access_contacts.claim_token_used_at
Enforcement         A single conditional UPDATE consumes the token before any
                    credential is touched. emergency-access-claim.controller.ts
                    runs UPDATE ... SET claim_token_used_at = CURRENT_TIMESTAMP
                    WHERE claim_token_hash = $1 AND claim_token_used_at IS NULL
                    AND claim_token_expires_at >= CURRENT_TIMESTAMP RETURNING; a
                    zero-row result is a NotFoundException, so the loser of two
                    concurrent completes writes nothing and rewrites no password.
Concurrency scope   per token, per owner
Retry semantics     Safe: the second complete finds the token consumed and is
                    refused.
Failure response    the loser gets 404, having written nothing --
                    docs/financial-calculation-contract.md section 7.
Required tests      Present: emergency-access-claim.controller.spec.ts asserts the
                    loser (a zero-row consume) is refused. A two-connection test is
                    the gold-standard proof still owed.
Status              enforced
```

### INV-AUTH-001 -- refresh rotation

```text
Statement           A presented refresh token rotates once; a second presentation
                    revokes the family.
Source of truth     refresh_tokens.is_revoked, per family_id
Enforcement         Pessimistic write lock on the RefreshToken row by tokenHash,
                    plus family revocation on a token already revoked. The loser
                    blocks on the lock, sees the winner's committed isRevoked,
                    and takes the reuse-detection branch.
Concurrency scope   per token family
Retry semantics     A retried rotation of the same token is reuse, not a retry,
                    and is treated as such by design.
Crash semantics     A crash before commit leaves the presented token valid; a
                    crash after leaves the successor valid. Both are consistent.
Failure response    401, family revoked.
Required tests      Two-connection: two concurrent rotations of one token; assert
                    the family ends revoked rather than two live successors.
Status              enforced
```

Recorded as enforced because the mechanism is real and correct -- and because it
is subtle enough that a future refactor could remove the lock without any test
noticing.

### INV-AUTH-004 -- a logout reports only what it achieved

```text
Statement           A logout that did not revoke the session must not be presented
                    to the user as a completed logout.
Source of truth     refresh_tokens.is_revoked for the family
Enforcement         The handler awaits the revoke before reporting success, and
                    the revoke is locked. auth.controller.ts logout awaits
                    revokeRefreshToken (under withSystemContext) before
                    clearAuthCookies and the success body, with no try/catch, so a
                    revoke failure propagates and is never presented as a completed
                    logout. The family revoke takes lockTokenFamily before its
                    UPDATE (token.service.ts revokeTokenFamily), so it is a real
                    protocol rather than the value's order-independence.
Concurrency scope   per token family
Retry semantics     Safe: setting is_revoked twice is a no-op.
Failure response    a failed revoke surfaces as an error, not a cleared session.
Required tests      Failpoint (the load-bearing kind per docs/verification-contract.md):
                    backend/test/integration/logout-revoke-failpoint.integration.spec.ts
                    forces the family-revocation write to fail with a BEFORE UPDATE
                    trigger and asserts the real revokeRefreshToken rejects and the
                    family stays live, with a control case proving the same call
                    revokes when nothing blocks it. Unit (supporting):
                    auth.controller.spec.ts asserts the controller propagates that
                    rejection without clearing cookies or emitting the success body.
                    Still owed: the user-visible E2E assertion.
Status              enforced
```

Split out from INV-AUTH-001 because the two are different properties that happen
to touch the same table. Rotation is about exactly-once; this is about truthful
reporting, and conflating them hid the fact that only the first has a mechanism.

### INV-AUTH-002 -- every failed login is counted

```text
Statement           A failed login attempt increments the counter the lockout
                    threshold reads.
Source of truth     users.failed_login_attempts
Enforcement         An atomic CTE increments in the database. recordFailedAttempt
                    (auth.service.ts) runs one UPDATE users SET
                    failed_login_attempts = failed_login_attempts + 1 with the
                    lockout threshold folded into the same statement -- not a
                    JavaScript read-modify-write across the bcrypt compare -- so
                    two concurrent failures cannot lose an increment. The
                    success-path reset writes a fixed absolute value and was always
                    safe.
Concurrency scope   per account
Failure response    the counter equals the number of failures; lockout is not
                    delayed.
Required tests      Present: auth.service.spec.ts asserts recordFailedAttempt is
                    the single incrementing statement (matched on
                    failed_login_attempts + RETURNING). A two-connection "N
                    concurrent failures, counter equals N" test is still owed.
Status              enforced
```

### INV-AUTH-003 -- a destructive OIDC action needs a real round trip

```text
Statement           Restore, delete-account, delete-data and step-up on an OIDC
                    account require a signed proof of a fresh identity-provider
                    authentication, bound to the user and the action, single-use
                    and short-lived.
Source of truth     the identity provider
Enforcement         A signed, single-use, short-lived reauth artifact bound to
                    the user and action. OidcReauthService.issue mints an HS256
                    JWT bound to sub + purpose + jti with a 5-minute TTL;
                    consume verifies signature, type, subject, action and exp,
                    then claimJti runs INSERT ... ON CONFLICT (jti) DO NOTHING
                    RETURNING (single-use across replicas), and isFreshAuthentication
                    requires a real IdP round trip via auth_time. Step-up's
                    client-asserted boolean is gone (step-up.service.ts calls
                    oidcReauth.consume). Wired into destructive routes
                    (users.service.ts, backup-restore.service.ts).
Concurrency scope   per user, per action
Failure response    401 until a valid, unspent, unexpired proof is presented.
Required tests      Present: OidcReauthService specs cover forge/replay/expiry and
                    the single-use jti claim.
Status              enforced
```

The old sentinel string 'oidc-session-confirmed' survives only in comments and
superseded tests; `docs/verification-contract.md` section 5 (known-wrong tests)
covers retiring those.

### INV-ACTIVITY-001 -- activity is attributed to whoever acted

```text
Statement           users.last_activity_at records the authenticated user who
                    made the request, never the user they are acting as.
Source of truth     the authenticated principal (req.user.realUserId)
Enforcement         The interceptor stamps the authenticated identity.
                    request-context.interceptor.ts calls
                    touchLastActivity(realUserId), where realUserId =
                    user?.realUserId ?? userId, and the write targets
                    { id: realUserId } -- so a delegate acting on an owner's data
                    stamps the delegate's row, not the owner's.
Concurrency scope   per user
Failure response    --
Required tests      Present: request-context.interceptor.spec.ts asserts the
                    update targets the delegate's id while acting, leaving the
                    owner's row untouched.
Status              enforced
```

This is not a cosmetic attribution bug. Emergency-access eligibility is computed
from `lastActivityAt` -- the whole feature is "the owner has not been seen for N
days". A delegate with routine access keeps resetting that clock, so the grant
that is supposed to fire never does, and the safeguard fails silently in the
direction that withholds access from the people it exists for.

### INV-PROFILE-001 -- a profile response is an allowlist

```text
Statement           Every user-profile response is built by naming the fields to
                    include, never by removing the fields to hide.
Source of truth     the User entity
Enforcement         An allowlist, not a removal list. users/user-profile.ts
                    builds every profile response by copying only PROFILE_FIELDS
                    (typed `satisfies readonly (keyof User)[]`); a new column is
                    absent by default until someone names it there.
                    toDelegatedUserProfile additionally drops the owner's
                    credential-state fields for an acting delegate.
Concurrency scope   per user, and per delegate
Failure response    --
Required tests      Present: users/user-profile.spec.ts proves the allowlist is
                    exact, drops every @Exclude() column (read off
                    class-transformer metadata via user-profile.test-util.ts's
                    fullyPopulatedUser with LEAK- sentinels), and source-scans
                    src/ for a removal-list sanitizer anywhere.
Status              enforced
```

A removal list would be wrong structurally: the default for a new column is
"exposed", so the defect could be introduced by a change that never touches this
file, and the route is delegate-accessible so the leak would cross users. The
allowlist inverts that default.

### INV-MCP-001 -- a session is bound to its credential

```text
Statement           An MCP session is bound to the specific credential that
                    opened it, and the presented token's current scopes are
                    re-read on every request.
Enforcement         The session is bound to the credential id and scopes are
                    re-read per request. mcp-http.controller.ts
                    authorizeExistingSession refuses with 403 unless
                    sessionUser.credentialId === authResult.credentialId (not just
                    userId), and re-binds scopes: authResult.scopes on every
                    request. validatePat runs per request, so a revoked token 401s
                    immediately rather than at TTL.
Concurrency scope   per session, per credential
Failure response    403 on a mismatched credential.
Required tests      Present: mcp-http.controller.spec.ts covers the 403
                    credential-mismatch and session/user-mismatch cases.
Status              enforced
```

### INV-CURRENCY-001 -- shared currency deletion

```text
Statement           A shared currency row is deleted only by its creator, and only
                    when a global reference count -- covering every foreign key in
                    the schema -- is zero, decided under a lock in the deleting
                    transaction.
Source of truth     currencies, and every table referencing currency_code
Enforcement         Creator-only, on a genuinely global count, under a lock.
                    CurrenciesService.removeWithin gates the currency-row delete on
                    createdByUserId === userId (a non-creator deactivates their own
                    preference but never takes the shared row), locks the currency
                    row with SELECT ... FOR UPDATE, and asks the SECURITY DEFINER
                    function currency_code_in_use_globally (migration 137) which
                    covers every FK including budgets and both exchange_rates
                    columns -- not the caller's tenant-scoped count.
Concurrency scope   global -- cross-tenant
Failure response    non-creator deactivates without deleting; 409 while referenced.
Required tests      Present: currency-references.spec.ts derives the reference list
                    from schema.sql in both directions so a new FK cannot be
                    forgotten; currencies.service.spec.ts asserts a non-creator's
                    remove deletes only the preference and never the currency row.
                    A two-connection delete-versus-use test is still owed.
Status              enforced
```

The global count is a SECURITY DEFINER function precisely so that under
`RLS_MODE=enforce` it does not degrade to a tenant-scoped count that sees only the
caller's rows and reports zero for another user's references.

## External effects

### INV-ATTACHMENT-001 -- metadata resolves to committed bytes

```text
Statement           Attachment metadata that a user can see resolves to bytes
                    that are durably present, and no bytes exist without
                    metadata.
Enforcement         Ordered so a failure leaves recoverable bytes, never a row
                    promising absent bytes. attachments.service.ts commits an
                    upload-intent tombstone on its own connection before the put,
                    compensates on rollback (storage.delete + clear the intent),
                    and distinguishes the database provider's joint commit from
                    external providers via objectWritten. A reconciliation job
                    exists: attachment-orphan-sweeper.service.ts (hourly, under
                    withSystemContext) claims tombstones and deletes leased-past
                    orphaned bytes. Local writes are crash-atomic
                    (local-storage.provider.ts writeFileAtomic). "No bytes without
                    metadata" holds eventually rather than instantaneously, which
                    is what the invariant asks.
Concurrency scope   per attachment
Retry semantics     Deletes are idempotent on a missing key; a failed create's
                    bytes are swept.
Crash semantics     A transient orphan on rollback is durably recoverable by the
                    sweeper, not silent.
Status              enforced
```

### INV-BACKUP-001 -- a backup is complete, verified, owner-namespaced

```text
Statement           A backup artifact is namespaced by owner, written completely,
                    and verified before it is reported as done.
Enforcement         Namespacing: userFolderPath uses shardedSegments(userId) for
                    <base>/<ab>/<cd>/<userId>/, because the filenames carry only a
                    tier and a date; browse and validate are admin-gated.
                    Completeness: writeFileAtomic (atomic-file.ts) writes to a temp
                    file, fsyncs, size-checks, then renames and fsyncs the dir, and
                    refuses to publish a short file; promotions use copyFileAtomic
                    with a size check, not copyFileSync. The durable completeness
                    verdict lives inside the document (completeness in the envelope,
                    backup-format.ts, reached from digests) and restore refuses an
                    artifact whose completeness.complete is false. Encrypted
                    artifacts are truncation-authenticated frame-by-frame
                    (backup-envelope.ts). lastBackupStatus reflects the outcome
                    (complete vs partial), not an unconditional success.
Concurrency scope   per user
Crash semantics     A kill or ENOSPC mid-write leaves the temp file, never a
                    truncated final name -- the rename is the publish.
Required tests      Present: atomic-file.spec.ts and auto-backup.service.spec.ts
                    use a real mkdtemp; backup.service.spec.ts asserts restore
                    honours the artifact's own completeness claim.
Status              enforced
```

Encryption is settled and worth not re-litigating: a support backup is
unconditionally encrypted because it exists to leave the user's machine, and an
automatic backup whose stored password cannot be decrypted is *refused* rather
than written in clear.

### INV-CRON-001 -- one logical effect per tick

```text
Statement           A scheduled job produces one logical effect per tick,
                    regardless of replica count.
Enforcement         Per job, and now mostly a durable cross-replica claim.
                    common/jobs/job-claim.service.ts provides claimOnce (INSERT ...
                    ON CONFLICT DO NOTHING RETURNING) and claimLease/markDelivered
                    (at-least-once with a lease token + migration-143 fence). The
                    jobs previously unguarded are guarded: scheduled auto-posting
                    (INV-OCCURRENCE-001, occurrence-key claim), budget rollover
                    (ON CONFLICT (budget_id, period_start) DO NOTHING RETURNING with
                    the loser re-reading the winner), AI insight generation
                    (claimLease, not a process-local Set), demo reset (claimLease).
                    The MNY reaper's conditional CAS and the price/FX refreshes'
                    natural-key ON CONFLICT were already real.
                    Still partial: the account-balance recompute is idempotent
                    against itself and, under INV-BALANCE-001's lock, against a
                    concurrent delta -- but per-job two-instance test coverage is
                    not demonstrably complete across every job.
Concurrency scope   per job, per logical key
Required tests      Two-instance per job. The MNY job has one; the others rely on
                    the claim layer's unit coverage and are still owed theirs.
Status              partial
```

`docs/cron-jobs.md` lists schedules; per section 7 of
`docs/concurrency-and-idempotency.md` it must also record, per job, what prevents
two replicas from producing the same effect.

## Platform

### INV-RLS-001 -- enforced mode refuses a privileged role

```text
Statement           Under RLS_MODE=enforce the application refuses to serve
                    traffic on a role that can bypass row-level security --
                    including membership reachable via SET ROLE, not only the
                    role's own attributes.
Enforcement         A single classifier refuses a privileged role at startup.
                    common/db/runtime-role-check.ts (assertRuntimeRoleSafe) reads
                    pg_roles for rolsuper/rolbypassrls/rolreplication/rolcreaterole/
                    rolcreatedb, database ownership, owned policied tables,
                    SET ROLE-reachable exempt contexts, inherited owner roles and
                    forbidden predefined-role memberships (pg_has_role, transitive).
                    Wired at both call sites: main.ts about its own connection
                    (process exit on violation -- "refuse to boot") and db-init.ts
                    about the configured role by name (assertRuntimeRoleSafeByName).
Concurrency scope   global, at startup
Failure response    Refuse to boot.
Required tests      Present: runtime-role-check.spec.ts (unit, incl. superuser,
                    BYPASSRLS and inherited-membership cases) and a live-catalog
                    integration spec.
Status              enforced
```

This is the backstop for the entire RLS design: if enforced mode is switched on
with a misconfigured role, startup now refuses rather than serving silently. Two
adjacent items are their own concerns, not this invariant's: delegation's
cross-user lookups (a candidate below) and whether `db-init` / `db-migrate` are
serialized across replicas -- `common/db/advisory-locks.ts` now exists and that
sub-point warrants its own re-check.

### INV-CACHE-001 -- a money-moving write invalidates its caches

```text
Statement           A write that changes money invalidates every client cache
                    family derived from transactions.
Enforcement         invalidateBalanceCaches (frontend lib/apiCache.ts) drops the
                    accounts:, investments: AND budgets: prefixes -- every
                    transaction-derived family. The cache layer is frontend, which
                    is why the function name does not appear in backend/src.
Concurrency scope   per browser tab
Failure response    a saved transaction drops the budget cache, so the progress
                    bar reflects the write.
Required tests      Present: frontend cache-prefix-classification.guard.test.ts
                    requires every cache prefix to declare itself transaction-
                    derived (and be dropped) or reference-data (and be kept), so a
                    new family cannot default to stale; balance-cache.guard.test.ts
                    requires every balance-writing API method to invalidate.
Status              enforced
```

### INV-RELEASE-001 -- one revision

```text
Statement           The tested commit, the published image's revision, the pushed
                    release commit and the release tag identify one source
                    revision, or a later full gate verifies the final revision.
Source of truth     the git commit SHA
Enforcement         Partial. The image half is right: prepare-release resolves
                    the SHA once in a job that creates no commit and threads it
                    into the build arg and the OCI revision annotation, and
                    cosign, the SBOM attestation and the Trivy gate all target
                    the digest. The git half is not: the release job pushes a
                    "[skip ci]" version-bump commit to protected main with an
                    admin PAT, nothing re-runs the gate on it, and gh release
                    create with no --target tags the branch tip.
Concurrency scope   global -- one release at a time, not currently enforced
Retry semantics     A re-run after a partial release may bump the version twice;
                    nothing detects an already-published version.
Crash semantics     A failure between the image push and the version-bump commit
                    leaves a published image no tag refers to.
Failure response    Refuse to tag rather than tag an unverified revision.
Required tests      A workflow self-test asserting the bump commit's parent is the
                    tested SHA and its diff touches only version manifests.
Status              partial
```

`docs/release-integrity.md` has the full rules and gap register, including the
unconditional `--passWithNoTests` on the integration suite.

## Candidates not yet admitted

These were raised while assembling the catalog and are **not** entries, because
each needs a direct reading of the source before it can be stated as an
invariant. They are listed so the work is not lost and so nobody re-derives them
from scratch; an unverified entry above the line would undermine every verified
one.

| Candidate | What to check |
| --- | --- |
| Delegation's cross-user lookups run in the caller's tenant scope | `delegation.service.ts` uses plain `withScopedDb` throughout, including `mayManageCredentials`. Inert at `RLS_MODE=off`; under `enforce` a cross-user count would see only the caller's rows. Confirm what each lookup needs before writing the rule. |
| An export must read every table from one snapshot | Whether `backup.service.ts`'s export methods share a transaction, and whether `REPEATABLE READ` is required for a self-consistent artifact. |
| Restore must handle self-referential FKs by insertion order | `accounts.linked_loan_account_id` and whether the strip/repair lists are hand-maintained and therefore drift-prone. |
| `record()` must not run inside an ambient transaction | Whether a failed action-history insert can abort a caller's write, and at what log level a lost undo entry surfaces. |
| Bootstrap must be serialized across replicas | `db-init` and `db-migrate` have no advisory lock; each pod decides from its own read of `schema_migrations`. The absence is confirmed; the required behaviour is not yet specified. |

## Using this catalog

**In a pull request.** Name the invariant IDs the change touches. If it moves one
from `unenforced` to `enforced`, update the entry in the same commit and delete
the citation of the violation -- an entry describing a violation that no longer
exists is worse than no entry, because it will be read and believed.

**In a review.** An entry marked `enforced` names its mechanism; check the change
does not remove it. INV-AUTH-001 is the live example -- correct today, and correct
by a lock whose purpose is not obvious from the call site.

**When adding an invariant.** It belongs here if it is cross-layer. A rule that
one service can enforce alone belongs in that service, or in a type, or in a lint
rule -- per root `CLAUDE.md`, prefer the highest enforcement the mistake allows,
and use prose only for the part that genuinely needs judgement. This document is
prose, which makes it the weakest of the available options and the one most in
need of the machine-checkable rules the entries above call for.
