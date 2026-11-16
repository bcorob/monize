import { ConflictException, Injectable } from "@nestjs/common";
import { DataSource, EntityManager, In, MoreThan } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  AiReviewRequest,
  AiReviewRequestStatus,
  MAX_AI_REVIEW_INSTRUCTION_LENGTH,
  MAX_PARSER_DRAFT_DOMAINS,
  MAX_PARSER_DRAFT_EMAILS,
  MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
} from "./ai-review-request.entity";

/** One request to queue: which row, which rule asked, and what to do. */
export interface AiReviewEnqueueInput {
  readonly transactionId: string;
  /** Null for a request no rule made. */
  readonly ruleId: string | null;
  readonly instruction: string;
}

export interface AiReviewEnqueueKey {
  readonly transactionId: string;
  readonly ruleId: string | null;
}

export interface AiReviewEnqueueResult {
  /** Requests that were written. */
  readonly queued: readonly AiReviewEnqueueKey[];
  /** Requests skipped because an open one already exists for the same row and rule. */
  readonly alreadyQueued: readonly AiReviewEnqueueKey[];
}

/**
 * A request raised for a stored order-confirmation email (email-receipts design
 * section 6). It has no rule. The receipts service queues it already claimed by
 * its own key (`enqueueClaimed`, which then submits as an agent does) or, for
 * the AI path, pending (`enqueuePendingForReceipt`).
 */
export interface AiReviewEnqueueClaimedInput {
  readonly transactionId: string;
  readonly kind: "email_receipt";
  readonly emailReceiptId: string;
  readonly instruction: string;
  /** The claim key the request is born with, e.g. `email-receipts`. */
  readonly claimedBy: string;
}

/**
 * A request to CREATE the investment transaction a brokerage's trade
 * confirmation email reports (`email_trade`). It has no transaction: there is
 * none yet. It is born claimed by the receipts module's own key and its
 * proposal is stored by the same module (`AiReviewWorkService.submitTrade`).
 */
export interface AiReviewEnqueueTradeInput {
  readonly emailReceiptId: string;
  readonly instruction: string;
  /**
   * The claim key the request is born with, e.g. `email-receipts` (a profile's
   * own proposal), or null for a request that waits `pending` for the assistant
   * or an agent ("Recognize as a trade with AI").
   */
  readonly claimedBy: string | null;
}

export interface AiReviewEnqueueForReceiptInput {
  readonly transactionId: string;
  readonly emailReceiptId: string;
  readonly instruction: string;
}

/**
 * A request to write a receipt parser from stored emails of one or more senders
 * (`email_parser_draft`). It has no transaction. `parserDomain` is the sender
 * domain the request is filed under; at most one such request is open per (user,
 * domain).
 */
export interface AiReviewEnqueueParserDraftInput {
  /** 1 to 25 stored emails of the user (at most 5 per domain, 5 domains); the caller has checked they are the user's. */
  readonly emailReceiptIds: readonly string[];
  readonly parserDomain: string;
  readonly instruction: string;
}

export interface ListAiReviewRequestsOptions {
  readonly status?: AiReviewRequestStatus;
  /** Any of these statuses; wins over `status`. */
  readonly statuses?: readonly AiReviewRequestStatus[];
  readonly limit?: number;
  /** Oldest first is the queue's own order; an inbox reads newest first. */
  readonly order?: "ASC" | "DESC";
  /** Leave out requests whose life has run out, whatever their stored status. */
  readonly unexpiredOnly?: boolean;
}

/** What an agent that gives up on a claimed request tells the queue. */
export interface ReleaseAiReviewRequestInput {
  /** True: the request cannot be done and becomes `rejected`. False: it returns to `pending`. */
  readonly final: boolean;
  readonly note: string;
}

/** The longest note an agent leaves when it gives a request up. */
export const MAX_AI_REVIEW_NOTE_LENGTH = 500;

export const DEFAULT_AI_REVIEW_LIST_LIMIT = 50;
export const MAX_AI_REVIEW_LIST_LIMIT = 200;
/** Rows per INSERT, so one statement never carries an unbounded array. */
const ENQUEUE_CHUNK_SIZE = 500;

interface RequestRow {
  id: string;
  user_id: string;
  transaction_id: string | null;
  rule_id: string | null;
  kind: AiReviewRequest["kind"];
  instruction: string;
  status: AiReviewRequestStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  proposal: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  email_receipt_id: string | null;
  email_receipt_ids: string[] | null;
  parser_domain: string | null;
}

/**
 * The parsers a parser-draft request lists, as a JSON array of text ids: its
 * `proposal.parserIds`, else the single `proposal.parserId` of a request written
 * before a request could hold two drafts, else empty. `q` is the request's alias.
 */
const PROPOSED_PARSER_IDS_SQL = `COALESCE(
  q.proposal -> 'parserIds',
  CASE WHEN q.proposal ->> 'parserId' IS NOT NULL
       THEN jsonb_build_array(q.proposal ->> 'parserId')
       ELSE '[]'::jsonb END)`;

function parserDraftClaimed(): ConflictException {
  return new ConflictException(
    tr(
      "errors.aiReview.parserDraftClaimed",
      "Your AI agent is already working on a profile for this sender. Wait for it to finish, or dismiss the request in the AI inbox and send a new one.",
    ),
  );
}

function toRequest(row: RequestRow): AiReviewRequest {
  return Object.assign(new AiReviewRequest(), {
    id: row.id,
    userId: row.user_id,
    transactionId: row.transaction_id,
    ruleId: row.rule_id,
    kind: row.kind,
    instruction: row.instruction,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    proposal: row.proposal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    emailReceiptId: row.email_receipt_id ?? null,
    emailReceiptIds: row.email_receipt_ids ?? null,
    parserDomain: row.parser_domain ?? null,
  });
}

/**
 * The AI review queue (design 6.5): durable requests that an AI look at one
 * transaction. A producer enqueues inside its own transaction; a consumer
 * claims. The queue never writes the ledger, and the transaction-rules module
 * depends on this one, never the other way round.
 */
@Injectable()
export class AiReviewRequestsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Queue requests in the caller's transaction, so a rollback of the insert
   * that asked drops them (INV-RULE-002). One `INSERT ... ON CONFLICT DO
   * NOTHING` per chunk against the partial unique index on
   * (transaction_id, rule_id) where the request is still open: a second
   * identical trigger inserts nothing and is reported in `alreadyQueued`.
   */
  async enqueue(
    m: EntityManager,
    userId: string,
    requests: readonly AiReviewEnqueueInput[],
  ): Promise<AiReviewEnqueueResult> {
    const queued: AiReviewEnqueueKey[] = [];
    const alreadyQueued: AiReviewEnqueueKey[] = [];
    for (let i = 0; i < requests.length; i += ENQUEUE_CHUNK_SIZE) {
      const chunk = requests.slice(i, i + ENQUEUE_CHUNK_SIZE);
      const inserted = returnedRows<{
        transaction_id: string;
        rule_id: string | null;
      }>(
        await m.query(
          `INSERT INTO ai_review_requests
             (user_id, transaction_id, rule_id, kind, instruction)
           SELECT $1, r.transaction_id, r.rule_id, 'transaction_review', r.instruction
             FROM unnest($2::uuid[], $3::uuid[], $4::text[])
                  AS r(transaction_id, rule_id, instruction)
           ON CONFLICT (transaction_id, rule_id)
             WHERE status IN ('pending', 'claimed', 'proposed')
           DO NOTHING
           RETURNING transaction_id, rule_id`,
          [
            userId,
            chunk.map((r) => r.transactionId),
            chunk.map((r) => r.ruleId),
            chunk.map((r) => r.instruction.trim()),
          ],
        ),
      );
      const written = new Set(
        inserted.map((row) => `${row.transaction_id}:${row.rule_id ?? ""}`),
      );
      for (const request of chunk) {
        const key = `${request.transactionId}:${request.ruleId ?? ""}`;
        const target = written.delete(key) ? queued : alreadyQueued;
        target.push({
          transactionId: request.transactionId,
          ruleId: request.ruleId,
        });
      }
    }
    return { queued, alreadyQueued };
  }

  /**
   * Queue a request for a stored email, born `claimed` by `claimedBy`, in the
   * caller's transaction. Null when an open request already exists for the
   * transaction (the receipt is then `review_conflict`); never a second one.
   *
   * The mechanism. A request with no rule is not covered by the partial unique
   * index on (transaction_id, rule_id): NULLs are distinct in a unique index, so
   * `ON CONFLICT` alone never fires for it. The exclusion is therefore (1) a
   * transaction-scoped advisory lock on the transaction id, so two writers of
   * rule-less requests for one transaction queue behind one another, and (2) an
   * `INSERT ... WHERE NOT EXISTS (an open, unexpired rule-less request)`, run
   * after the lock so the second writer sees the first's committed row. The
   * `ON CONFLICT` stays for the case a rule-ful request is ever passed here.
   * Take this call early in the transaction: advisory locks come before row
   * locks (`docs/concurrency-and-idempotency.md`).
   */
  async enqueueClaimed(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueClaimedInput,
  ): Promise<AiReviewRequest | null> {
    return this.insertReceiptRequest(m, userId, input, {
      status: "claimed",
      claimedBy: input.claimedBy,
    });
  }

  /**
   * Queue a request for a stored email for the AI path: `pending`, so any agent
   * (or the assistant) can claim it. Same exclusion, same null, as
   * {@link enqueueClaimed}.
   */
  async enqueuePendingForReceipt(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueForReceiptInput,
  ): Promise<AiReviewRequest | null> {
    return this.insertReceiptRequest(
      m,
      userId,
      { ...input, kind: "email_receipt" },
      { status: "pending", claimedBy: null },
    );
  }

  private async insertReceiptRequest(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueForReceiptInput & { kind: "email_receipt" },
    born: { status: "claimed" | "pending"; claimedBy: string | null },
  ): Promise<AiReviewRequest | null> {
    await acquireAdvisoryLock(
      m,
      LockScope.AiReviewRequests,
      input.transactionId,
    );
    const [row] = returnedRows<RequestRow>(
      await m.query(
        `INSERT INTO ai_review_requests
           (user_id, transaction_id, rule_id, kind, instruction, status,
            claimed_by, claimed_at, email_receipt_id)
         SELECT $1::uuid, $2::uuid, NULL, $3::varchar, $4::text, $5::varchar,
                $6::text,
                CASE WHEN $6::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
                $7::uuid
          WHERE NOT EXISTS (
                  SELECT 1
                    FROM ai_review_requests open_request
                   WHERE open_request.user_id = $1::uuid
                     AND open_request.transaction_id = $2::uuid
                     AND open_request.rule_id IS NULL
                     AND open_request.status IN ('pending', 'claimed', 'proposed')
                     AND open_request.expires_at > CURRENT_TIMESTAMP)
         ON CONFLICT (transaction_id, rule_id)
           WHERE status IN ('pending', 'claimed', 'proposed')
         DO NOTHING
         RETURNING *`,
        [
          userId,
          input.transactionId,
          input.kind,
          input.instruction.trim().slice(0, MAX_AI_REVIEW_INSTRUCTION_LENGTH),
          born.status,
          born.claimedBy,
          input.emailReceiptId,
        ],
      ),
    );
    return row ? toRequest(row) : null;
  }

  /**
   * Queue the proposal of a trade confirmation, already claimed, in the caller's
   * transaction. At most one is open per email, held by the partial unique index
   * `uq_ai_review_requests_trade_open`; the caller closes the email's earlier
   * requests first (`closeReceiptRequests`), so a reprocess replaces the
   * proposal, and the unique index is the backstop for a writer that skipped
   * that. Returns null when one is still open.
   */
  async enqueueTrade(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueTradeInput,
  ): Promise<AiReviewRequest | null> {
    const [row] = returnedRows<RequestRow>(
      await m.query(
        `INSERT INTO ai_review_requests
           (user_id, transaction_id, rule_id, kind, instruction, status,
            claimed_by, claimed_at, email_receipt_id)
         VALUES ($1::uuid, NULL, NULL, 'email_trade', $2::text,
                 CASE WHEN $3::text IS NULL THEN 'pending' ELSE 'claimed' END,
                 $3::text,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
                 $4::uuid)
         ON CONFLICT (email_receipt_id)
           WHERE kind = 'email_trade' AND status IN ('pending', 'claimed', 'proposed')
         DO NOTHING
         RETURNING *`,
        [
          userId,
          input.instruction.trim().slice(0, MAX_AI_REVIEW_INSTRUCTION_LENGTH),
          input.claimedBy,
          input.emailReceiptId,
        ],
      ),
    );
    return row ? toRequest(row) : null;
  }

  /**
   * Queue a request to write a receipt parser from stored emails, `pending` so
   * any agent (or the assistant) can claim it, in the caller's transaction. At
   * most one is open per (user, sender domain), and a new one REPLACES the open
   * one for the same sender: the person who asks again wants the new selection of
   * emails, and the old request is closed (`rejected`) in the same transaction.
   *
   * The mechanism. (1) A transaction-scoped advisory lock on `<user>:<domain>`
   * queues two creators for one sender behind each other. (2) A request whose
   * life has run out but the hourly sweep has not marked is `expired` first, so
   * it cannot hold the slot. (3) Every other open one for the sender is closed.
   * (4) The INSERT. The partial unique index
   * `uq_ai_review_requests_parser_draft_open` is the backstop: a writer that
   * somehow skipped the lock fails with a unique violation instead of leaving two
   * open requests. A draft parser an earlier request already produced is NOT
   * touched: it is the user's to approve or delete.
   */
  async enqueueParserDraft(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueParserDraftInput,
  ): Promise<AiReviewRequest> {
    if (
      input.emailReceiptIds.length < 1 ||
      input.emailReceiptIds.length > MAX_PARSER_DRAFT_EMAILS
    ) {
      throw new Error("A parser draft request names 1 to 25 emails");
    }
    await acquireAdvisoryLock(
      m,
      LockScope.AiParserDraftRequests,
      `${userId}:${input.parserDomain}`,
    );
    await m.query(
      `UPDATE ai_review_requests
          SET status = 'expired'
        WHERE user_id = $1
          AND kind = 'email_parser_draft'
          AND parser_domain = $2
          AND status IN ('pending', 'claimed', 'proposed')
          AND expires_at <= CURRENT_TIMESTAMP`,
      [userId, input.parserDomain],
    );
    await m.query(
      `UPDATE ai_review_requests
          SET status = 'rejected'
        WHERE user_id = $1
          AND kind = 'email_parser_draft'
          AND parser_domain = $2
          AND status IN ('pending', 'claimed', 'proposed')`,
      [userId, input.parserDomain],
    );
    const [row] = returnedRows<RequestRow>(
      await m.query(
        `INSERT INTO ai_review_requests
           (user_id, transaction_id, rule_id, kind, instruction, status,
            email_receipt_ids, parser_domain)
         VALUES ($1::uuid, NULL, NULL, 'email_parser_draft', $2::text,
                 'pending', $3::uuid[], $4::varchar)
         RETURNING *`,
        [
          userId,
          input.instruction.trim().slice(0, MAX_AI_REVIEW_INSTRUCTION_LENGTH),
          [...input.emailReceiptIds],
          input.parserDomain,
        ],
      ),
    );
    return toRequest(row);
  }

  /**
   * The profile wizard's "send to AI": queue a parser-draft request for the
   * sender, or, when one is still `pending` (no agent has taken it), REPLACE its
   * instruction and emails in place, so the id the wizard waits on stays valid. A
   * request an agent has CLAIMED is refused (409): the agent is working from the
   * old text, and swapping it under them would answer the wrong question. A
   * `proposed` one (a draft already answers it) is closed and a new request
   * queued, as {@link enqueueParserDraft} does.
   *
   * The mechanism is the same as {@link enqueueParserDraft}: one advisory lock
   * on `<user>:<domain>`, held to the end of the transaction, with the check and
   * the write inside it, so a claim that commits first is seen and a claim that
   * arrives later finds the new text (the UPDATE is conditional on `pending`).
   */
  async queueParserDraft(
    m: EntityManager,
    userId: string,
    input: AiReviewEnqueueParserDraftInput,
  ): Promise<AiReviewRequest> {
    // The wizard's request is for one sender: five emails, not the 25 of a
    // multi-domain request (`enqueueParserDraft`).
    if (
      input.emailReceiptIds.length < 1 ||
      input.emailReceiptIds.length > MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN
    ) {
      throw new Error(
        `A wizard parser draft request names 1 to ${MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN} emails`,
      );
    }
    await acquireAdvisoryLock(
      m,
      LockScope.AiParserDraftRequests,
      `${userId}:${input.parserDomain}`,
    );
    const open = returnedRows<{ id: string; status: AiReviewRequestStatus }>(
      await m.query(
        `SELECT id, status
           FROM ai_review_requests
          WHERE user_id = $1
            AND kind = 'email_parser_draft'
            AND parser_domain = $2
            AND status IN ('pending', 'claimed')
            AND expires_at > CURRENT_TIMESTAMP
          ORDER BY created_at DESC, id DESC
            FOR UPDATE`,
        [userId, input.parserDomain],
      ),
    );
    if (open.some((row) => row.status === "claimed")) {
      throw parserDraftClaimed();
    }
    const pending = open[0];
    if (pending) {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET instruction = $3::text,
                  email_receipt_ids = $4::uuid[]
            WHERE id = $1
              AND user_id = $2
              AND status = 'pending'
           RETURNING *`,
          [
            pending.id,
            userId,
            input.instruction.trim().slice(0, MAX_AI_REVIEW_INSTRUCTION_LENGTH),
            [...input.emailReceiptIds],
          ],
        ),
      );
      // The row is locked above, so a miss would mean it left `pending` inside
      // this transaction; refuse rather than report a request that is not queued.
      if (!row) {
        throw parserDraftClaimed();
      }
      return toRequest(row);
    }
    return this.enqueueParserDraft(m, userId, input);
  }

  /**
   * The agent that holds a parser-draft request has saved a draft: move the
   * request to `proposed` and remember which parsers answer it (`proposal =
   * { parserId, parserIds, proposedAt }`: `parserId` is the first draft and stays
   * it, `parserIds` every draft in save order, at most `MAX_PARSER_DRAFT_DOMAINS`, no duplicate). ONE
   * conditional UPDATE in the caller's transaction, the same one that wrote the
   * parser: it matches only a request of this kind whose `claimed_by` is this
   * caller and whose life has not run out, and that is `claimed`, or `proposed`
   * while it spans several sender domains and holds fewer than `MAX_PARSER_DRAFT_DOMAINS` drafts (or already
   * lists this one). A caller that never claimed it (or lost the claim to a
   * dismissal, a replacement or an expiry) matches nothing. Returns whether it
   * matched; the caller refuses before writing the parser when it did not.
   */
  async proposeParserDraft(
    m: EntityManager,
    userId: string,
    id: string,
    claimedBy: string,
    parserId: string,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `UPDATE ai_review_requests q
            SET status = 'proposed',
                proposal = jsonb_build_object(
                  'parserId', COALESCE(q.proposal ->> 'parserId', $4::text),
                  'parserIds',
                    CASE WHEN ${PROPOSED_PARSER_IDS_SQL} @> jsonb_build_array($4::text)
                         THEN ${PROPOSED_PARSER_IDS_SQL}
                         ELSE ${PROPOSED_PARSER_IDS_SQL} || jsonb_build_array($4::text)
                    END,
                  'proposedAt', CURRENT_TIMESTAMP)
          WHERE q.id = $1
            AND q.user_id = $2
            AND q.kind = 'email_parser_draft'
            AND q.claimed_by = $3
            AND q.expires_at > CURRENT_TIMESTAMP
            AND (q.status = 'claimed'
                 OR (q.status = 'proposed'
                     AND (SELECT COUNT(DISTINCT r.from_domain)
                            FROM email_receipts r
                           WHERE r.user_id = q.user_id
                             AND r.id = ANY(q.email_receipt_ids)
                             AND r.from_domain <> '') > 1
                     AND (jsonb_array_length(${PROPOSED_PARSER_IDS_SQL}) < $5::int
                          OR ${PROPOSED_PARSER_IDS_SQL} @> jsonb_build_array($4::text))))
         RETURNING q.id`,
        [id, userId, claimedBy, parserId, MAX_PARSER_DRAFT_DOMAINS],
      ),
    );
    return rows.length > 0;
  }

  /**
   * A parser was approved: every `proposed` parser-draft request that lists it
   * is `applied` once EVERY parser it lists (`parserIds`, else the single
   * `parserId`) is an approved parser of the user's, in the approving
   * transaction (the approval's own UPDATE is visible to the check). A request
   * that lists another parser still unapproved, or since deleted, stays
   * `proposed`. Nothing matching is not an error (a draft written by hand, or by a
   * request since dismissed).
   */
  async markParserDraftApplied(
    m: EntityManager,
    userId: string,
    parserId: string,
  ): Promise<number> {
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `UPDATE ai_review_requests q
            SET status = 'applied'
          WHERE q.user_id = $1
            AND q.kind = 'email_parser_draft'
            AND q.status = 'proposed'
            AND ${PROPOSED_PARSER_IDS_SQL} @> jsonb_build_array($2::text)
            AND NOT EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(${PROPOSED_PARSER_IDS_SQL}) AS listed(id)
                   WHERE NOT EXISTS (
                           SELECT 1
                             FROM email_receipt_parsers p
                            WHERE p.user_id = q.user_id
                              AND p.id::text = listed.id
                              AND p.status = 'approved'))
         RETURNING q.id`,
        [userId, parserId],
      ),
    );
    return rows.length;
  }

  /**
   * A parser was deleted: the open parser-draft requests that listed it are
   * dismissed (`rejected`) when none of the parsers they list exists any more, so
   * the inbox does not offer a draft that is gone. A multi-domain request whose
   * other draft is still there stays `proposed`. The caller deletes the parser
   * first, in the same transaction, so the check does not see the deleted row.
   */
  async dismissParserDraftsFor(
    m: EntityManager,
    userId: string,
    parserId: string,
  ): Promise<number> {
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `UPDATE ai_review_requests q
            SET status = 'rejected'
          WHERE q.user_id = $1
            AND q.kind = 'email_parser_draft'
            AND q.status IN ('pending', 'claimed', 'proposed')
            AND ${PROPOSED_PARSER_IDS_SQL} @> jsonb_build_array($2::text)
            AND NOT EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(${PROPOSED_PARSER_IDS_SQL}) AS listed(id)
                    JOIN email_receipt_parsers p
                      ON p.user_id = q.user_id
                     AND p.id::text = listed.id)
         RETURNING q.id`,
        [userId, parserId],
      ),
    );
    return rows.length;
  }

  /** The user's requests, oldest first unless told otherwise, optionally in some statuses. */
  async listForUser(
    userId: string,
    options: ListAiReviewRequestsOptions = {},
  ): Promise<AiReviewRequest[]> {
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_AI_REVIEW_LIST_LIMIT), 1),
      MAX_AI_REVIEW_LIST_LIMIT,
    );
    const order = options.order ?? "ASC";
    const statusFilter = options.statuses
      ? { status: In([...options.statuses]) }
      : options.status
        ? { status: options.status }
        : {};
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(AiReviewRequest).find({
        where: {
          userId,
          ...statusFilter,
          ...(options.unexpiredOnly ? { expiresAt: MoreThan(new Date()) } : {}),
        },
        order: { createdAt: order, id: order },
        take: limit,
      }),
    );
  }

  /** One of the user's requests, or null. Another user's id reads as absent. */
  async getForUser(
    userId: string,
    id: string,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(AiReviewRequest).findOne({ where: { id, userId } }),
    );
  }

  /**
   * Claim the user's oldest pending, unexpired request for `claimedBy`, or
   * return null when there is none. The mechanism (docs/concurrency-and-
   * idempotency.md, conditional UPDATE plus a row lock): ONE statement whose
   * subselect takes the candidate `FOR UPDATE SKIP LOCKED` and whose outer
   * `WHERE status = 'pending'` re-checks it, so two agents claiming at once
   * never receive the same row -- the loser skips the locked row, or matches
   * nothing once the winner has committed. A null is not proof the queue is
   * empty under contention; the caller asks again.
   */
  async claimNext(
    userId: string,
    claimedBy: string,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'claimed',
                  claimed_by = $2,
                  claimed_at = CURRENT_TIMESTAMP
            WHERE id = (
                    SELECT id
                      FROM ai_review_requests
                     WHERE user_id = $1
                       AND status = 'pending'
                       AND expires_at > CURRENT_TIMESTAMP
                     ORDER BY created_at, id
                     LIMIT 1
                       FOR UPDATE SKIP LOCKED)
              AND status = 'pending'
              AND user_id = $1
           RETURNING *`,
          [userId, claimedBy],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Claim one named request for `claimedBy`, or null when it is not the user's,
   * is no longer `pending`, or has expired. ONE conditional UPDATE, the same
   * mechanism as {@link claimNext}: whoever wins the row takes it, and the loser
   * matches nothing. For a caller that already holds the id -- the receipts
   * page asking the AI about one email -- and so must not take "the oldest".
   */
  async claimById(
    userId: string,
    id: string,
    claimedBy: string,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'claimed',
                  claimed_by = $3,
                  claimed_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND user_id = $2
              AND status = 'pending'
              AND expires_at > CURRENT_TIMESTAMP
           RETURNING *`,
          [id, userId, claimedBy],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Store the proposal of the agent that holds the claim and move the request to
   * `proposed`. ONE conditional UPDATE: it matches only a `claimed` request
   * whose `claimed_by` is this caller and whose life has not run out, so an
   * agent that never claimed it (or lost the claim to a dismissal, an expiry or
   * a release) writes nothing and gets null. The proposal is a signed pending
   * action; the ledger is not touched.
   */
  async submitProposal(
    userId: string,
    id: string,
    claimedBy: string,
    proposal: Record<string, unknown>,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'proposed',
                  proposal = $4::jsonb
            WHERE id = $1
              AND user_id = $2
              AND status = 'claimed'
              AND claimed_by = $3
              AND expires_at > CURRENT_TIMESTAMP
           RETURNING *`,
          [id, userId, claimedBy, JSON.stringify(proposal)],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Give up a claim. The same conditional shape as {@link submitProposal}: only
   * the caller that holds the claim can release it. `final` false returns the
   * request to `pending` with the claim cleared, so another agent (or this one
   * later) can take it; `final` true marks it `rejected`, for a request that no
   * agent can do, so the queue does not hand it out again. The agent's note is
   * kept in `proposal` (`{ agentNote }`) so the next reader sees why.
   */
  async release(
    userId: string,
    id: string,
    claimedBy: string,
    input: ReleaseAiReviewRequestInput,
  ): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = CASE WHEN $4::boolean THEN 'rejected' ELSE 'pending' END,
                  claimed_by = NULL,
                  claimed_at = NULL,
                  proposal = jsonb_build_object(
                    'agentNote',
                    jsonb_build_object('reason', $5::text, 'at', CURRENT_TIMESTAMP))
            WHERE id = $1
              AND user_id = $2
              AND status = 'claimed'
              AND claimed_by = $3
           RETURNING *`,
          [
            id,
            userId,
            claimedBy,
            input.final,
            input.note.slice(0, MAX_AI_REVIEW_NOTE_LENGTH),
          ],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * The person dismisses a request that is still open: `rejected`, whoever
   * holds the claim. Null when it is not the user's or is no longer open.
   */
  async dismiss(userId: string, id: string): Promise<AiReviewRequest | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const [row] = returnedRows<RequestRow>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'rejected'
            WHERE id = $1
              AND user_id = $2
              AND status IN ('pending', 'claimed', 'proposed')
           RETURNING *`,
          [id, userId],
        ),
      );
      return row ? toRequest(row) : null;
    });
  }

  /**
   * Mark a proposed request `applied` inside the transaction that writes what it
   * proposed, so the two commit or roll back together. The UPDATE is bound to
   * the user, to the transaction the proposal was about and to `proposed`; a
   * request that was dismissed, expired or is about another transaction matches
   * nothing and the caller's write is refused (409) before it happens -- the
   * caller runs this first, under the row lock.
   */
  async markApplied(
    m: EntityManager,
    userId: string,
    id: string,
    transactionId: string,
  ): Promise<void> {
    const applied = returnedRows<{ id: string }>(
      await m.query(
        `UPDATE ai_review_requests
            SET status = 'applied'
          WHERE id = $1
            AND user_id = $2
            AND transaction_id = $3
            AND status = 'proposed'
         RETURNING id`,
        [id, userId, transactionId],
      ),
    );
    if (applied.length === 0) {
      throw new ConflictException(
        tr(
          "errors.aiReview.notProposed",
          "This AI review request is no longer waiting for approval, so its proposal was not applied.",
        ),
      );
    }
  }

  /**
   * Mark a proposed `email_trade` request `applied` inside the transaction that
   * creates the investment transaction it proposed, so the two commit or roll
   * back together. The UPDATE is bound to the user, to the kind and to
   * `proposed`: a request that was dismissed or expired since the card was built
   * matches nothing and the caller's write is refused (409) before it happens.
   * The caller runs this first, under the holdings lock. Returns the email the
   * request was raised for (null once that email is deleted).
   */
  async markTradeApplied(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<{ emailReceiptId: string | null }> {
    const applied = returnedRows<{
      id: string;
      email_receipt_id: string | null;
    }>(
      await m.query(
        `UPDATE ai_review_requests
            SET status = 'applied'
          WHERE id = $1
            AND user_id = $2
            AND kind = 'email_trade'
            AND status = 'proposed'
            AND expires_at > CURRENT_TIMESTAMP
         RETURNING id, email_receipt_id`,
        [id, userId],
      ),
    );
    if (applied.length === 0) {
      throw new ConflictException(
        tr(
          "errors.aiReview.notProposed",
          "This AI review request is no longer waiting for approval, so its proposal was not applied.",
        ),
      );
    }
    return { emailReceiptId: applied[0].email_receipt_id };
  }

  /**
   * Whether confirming this request's proposal is left out of the daily AI write
   * count (email-receipts design 7.1): the user's own switch on their mailbox,
   * `profile_proposals_count_toward_ai_limit`, is false AND the request is an
   * `email_receipt` one still `proposed` whose proposal was submitted under
   * `profileClaimKey` (the deterministic profile's key, never an AI's or an
   * agent's). ONE read of the server's own rows keyed on the user: a client
   * cannot claim the exemption, only the stored claim and the stored switch grant
   * it. A request that is not found, is someone else's, or any other kind or key
   * is not exempt, and so is a user with no mailbox: the default is to count.
   */
  async isExemptFromWriteLimit(
    userId: string,
    requestId: string,
    profileClaimKey: string,
  ): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ counts: boolean }>(
        await m.query(
          `SELECT mb.profile_proposals_count_toward_ai_limit AS counts
             FROM ai_review_requests r
             JOIN email_receipt_mailboxes mb ON mb.user_id = r.user_id
            WHERE r.id = $1
              AND r.user_id = $2
              AND r.kind = 'email_receipt'
              AND r.status = 'proposed'
              AND r.claimed_by = $3`,
          [requestId, userId, profileClaimKey],
        ),
      ),
    );
    return rows.length > 0 && rows[0].counts === false;
  }

  /**
   * Mark every open request whose life has run out as `expired` (a request is
   * reported as expired, never deleted). Returns how many changed. NOT
   * scheduled: a cron is a reviewed `WITH_CONTEXT_ALLOWLIST` decision. Under a
   * user's identity it reaches only that user's rows; a sweep across users
   * must run under `withSystemContext`.
   */
  async expireStale(): Promise<number> {
    return withScopedDb(this.dataSource, async (m) => {
      const expired = returnedRows<{ id: string }>(
        await m.query(
          `UPDATE ai_review_requests
              SET status = 'expired'
            WHERE status IN ('pending', 'claimed', 'proposed')
              AND expires_at <= CURRENT_TIMESTAMP
           RETURNING id`,
        ),
      );
      return expired.length;
    });
  }
}
