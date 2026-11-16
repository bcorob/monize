import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../../common/jobs/job-claim.service";
import { tr } from "../../i18n/translate";
import { EmailReceiptAiService } from "../ai/email-receipt-ai.service";
import type { EmailReceiptAiMode } from "../entities/email-receipt-mailbox.entity";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import {
  ImapMailboxClient,
  type FetchSinceResult,
} from "../imap/imap-mailbox-client";
import { EmailReceiptMailboxService } from "../mailbox/email-receipt-mailbox.service";
import {
  describeFailure,
  EmailReceiptPipelineService,
} from "../pipeline/email-receipt-pipeline.service";
import { EmailReceiptsAttentionAlertService } from "./email-receipts-attention-alert.service";
import {
  resolveEmailReceiptPollLimits,
  type EmailReceiptPollLimits,
} from "./email-receipt-poll-limits";
import { loadOwnAddresses, ownAddressesOnce } from "./own-addresses";
import {
  buildReceiptRow,
  insertReceiptRows,
  skippedRow,
  type ReceiptRow,
} from "./receipt-rows";

import { PROVIDER_CALL_BUDGET_MS } from "../../ai/providers/provider-call-budget";

export { pickReceivedAt } from "./receipt-rows";

/** No new work, provider calls included, is started once this much of the lease is spent. */
const LEASE_WORK_BUDGET_MS = 8 * 60_000;
/**
 * One poll of one mailbox holds its lease this long (design INV-RECEIPT-006),
 * renewed while it runs: the work budget plus the slowest single provider call
 * that may start just before the budget ends, plus a margin. It was ten
 * minutes, shorter than one Ollama call, so a second poll started beside a
 * draft still running (A26-S11-01).
 */
export const POLL_LEASE_MS =
  LEASE_WORK_BUDGET_MS + PROVIDER_CALL_BUDGET_MS + 2 * 60_000;
/** A first sync reads what arrived in the last 30 days (design 3.4). */
const FIRST_SYNC_DAYS = 30;
/** Stored emails processed, and emails re-matched, per poll. */
export const MAX_PROCESSED_PER_POLL = 100;
export const MAX_REMATCHED_PER_POLL = 100;
/**
 * AI category questions one poll may ask (design 5.6): each is a provider call,
 * so past this the receipts that need one are queued for an agent instead.
 */
export const AI_CATEGORY_CALLS_PER_POLL = 10;
/** An unmatched email is retried for this many days after it arrived (design 3.8). */
const REMATCH_DAYS = 30;
const DAY_MS = 86_400_000;

/** What one poll did. `busy` is a poll that found another holding the lease. */
export interface EmailReceiptPollOutcome {
  ok: boolean;
  busy: boolean;
  /** Emails stored this poll (a UID already stored is not counted). */
  fetched: number;
  /** Messages stored as `skipped` (too large, or undecodable). */
  skipped: number;
  /** Stored emails the pipeline acted on. */
  processed: number;
  /** Why the mailbox could not be read, bounded and free of secrets. */
  error?: string;
}

/** The answer to "Poll now": the outcome, or the error. */
export type EmailReceiptPollNowResult = Omit<
  EmailReceiptPollOutcome,
  "busy"
> & {
  busy?: boolean;
};

const EMPTY: EmailReceiptPollOutcome = {
  ok: true,
  busy: false,
  fetched: 0,
  skipped: 0,
  processed: 0,
};

/**
 * The poll of the receipts mailboxes (design sections 6 and 8): every 15
 * minutes, per enabled mailbox, under a per-mailbox lease, read what arrived
 * since the cursor, store it, run the pipeline over what is pending, retry what
 * did not match, and (mode `automatic`) take the bounded AI step.
 *
 * What stops a second replica repeating it (docs/concurrency-and-idempotency.md
 * section 7): `claimLease(EmailReceiptPoll, userId, mailboxId)`, taken per
 * mailbox and released by its token in a `finally`, so the loser does nothing;
 * and, underneath it, `UNIQUE (mailbox_id, uid_validity, uid)` with
 * `ON CONFLICT DO NOTHING`, so a message read twice is stored once
 * (INV-RECEIPT-002). The in-process `running` flag only stops this replica
 * stacking ticks; it decides nothing.
 *
 * Identity: the fan-out is `withSystemContext` (it lists every user's enabled
 * mailbox), and each mailbox runs under `withUserContext(userId)`, the lease
 * included (a lease is database access too). A failure for one user is logged
 * and the loop goes on; the failure line is the mailbox's own bounded,
 * secret-free one (`describeMailboxFailure`), never the password.
 */
@Injectable()
export class EmailReceiptPollService {
  private readonly logger = new Logger(EmailReceiptPollService.name);
  private readonly limits: EmailReceiptPollLimits =
    resolveEmailReceiptPollLimits(process.env, this.logger);
  /** Whether a tick is in flight on this replica. */
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailbox: EmailReceiptMailboxService,
    private readonly imap: ImapMailboxClient,
    private readonly jobClaims: JobClaimService,
    private readonly pipeline: EmailReceiptPipelineService,
    private readonly ai: EmailReceiptAiService,
    private readonly attention: EmailReceiptsAttentionAlertService,
  ) {}

  @Cron("*/15 * * * *")
  async pollAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mailboxes = await withSystemContext(() =>
        this.mailbox.listEnabledMailboxes(),
      );
      for (const { id, userId } of mailboxes) {
        try {
          await withUserContext(userId, () =>
            this.pollMailbox(userId, id, { requireEnabled: true }),
          );
        } catch (error) {
          this.logger.warn(
            `Receipt poll failed user=${userId} (${describeFailure(error)})`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Receipt poll could not list the mailboxes (${describeFailure(error)})`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * "Poll now": the same code path as the cron, under the caller's own request
   * identity, whether or not the mailbox is set to be read automatically: the
   * `enabled` switch decides only whether the 15-minute cron polls it
   * (`listEnabledMailboxes`), never whether the person can. The lease makes it a
   * no-op while a cron run (or another press) holds the mailbox, and makes a
   * concurrent cron run a no-op while this one does. A mailbox that cannot be
   * read (including an OAuth2 one whose sign-in was revoked or disconnected: no
   * token, so it cannot connect, and the poll says to connect it again) is an
   * `ok: false` result with the reason, not an exception; a user with no mailbox
   * is a 404.
   */
  async pollNow(userId: string): Promise<EmailReceiptPollNowResult> {
    const view = await this.mailbox.getView(userId);
    if (!view) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.mailboxNotFound",
          "No mailbox is set up for this account.",
        ),
      );
    }
    const outcome = await this.pollMailbox(userId, view.id, {
      requireEnabled: false,
    });
    if (outcome.busy) {
      return {
        ...outcome,
        ok: false,
        error: tr(
          "errors.emailReceipts.pollBusy",
          "The mailbox is being read right now. Try again in a minute.",
        ),
      };
    }
    return outcome;
  }

  /**
   * The stored-email part of a poll, for the archive import: pending emails, the
   * re-match and (mode `automatic`) the bounded AI step, under the same mailbox
   * lease as a poll (INV-RECEIPT-006). It never connects to the mail server and
   * does not need the mailbox to be enabled. A held lease is `busy` and nothing
   * is processed; the rows wait for the next poll. No mailbox is a 404.
   */
  async processStoredNow(
    userId: string,
  ): Promise<{ processed: number; busy: boolean }> {
    const view = await this.mailbox.getView(userId);
    if (!view) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.mailboxNotFound",
          "No mailbox is set up for this account.",
        ),
      );
    }
    const leaseToken = await this.jobClaims.claimLease(
      JobClaimType.EmailReceiptPoll,
      userId,
      view.id,
      POLL_LEASE_MS,
    );
    if (leaseToken === null) return { processed: 0, busy: true };
    const deadline = Date.now() + LEASE_WORK_BUDGET_MS;
    try {
      return await this.whileLeaseHeld(
        userId,
        view.id,
        leaseToken,
        async () => {
          const outcome: EmailReceiptPollOutcome = { ...EMPTY };
          await this.processStored(
            userId,
            view.id,
            view.aiMode,
            outcome,
            deadline,
          );
          await this.attention.evaluate(userId);
          return { processed: outcome.processed, busy: false };
        },
      );
    } finally {
      await this.releaseLease(userId, view.id, leaseToken);
    }
  }

  /**
   * One mailbox under its lease. The caller has seeded the identity (the cron's
   * `withUserContext`, or the request's own), so the lease claim and its
   * release, like everything inside, find one.
   */
  async pollMailbox(
    userId: string,
    mailboxId: string,
    options: { requireEnabled: boolean },
  ): Promise<EmailReceiptPollOutcome> {
    const leaseToken = await this.jobClaims.claimLease(
      JobClaimType.EmailReceiptPoll,
      userId,
      mailboxId,
      POLL_LEASE_MS,
    );
    if (leaseToken === null) return { ...EMPTY, busy: true };
    const deadline = Date.now() + LEASE_WORK_BUDGET_MS;
    try {
      return await this.whileLeaseHeld(
        userId,
        mailboxId,
        leaseToken,
        async () => {
          const outcome = await this.pollLeased(
            userId,
            mailboxId,
            options,
            deadline,
          );
          // After the pipeline ran: one notification per user when emails wait
          // for a profile or a fix. Never throws (it logs), and runs under the
          // owner's identity this method was called with.
          await this.attention.evaluate(userId);
          return outcome;
        },
      );
    } finally {
      await this.releaseLease(userId, mailboxId, leaseToken);
    }
  }

  /** The poll's work under its lease, renewed while it runs (A26-L13). */
  private whileLeaseHeld<T>(
    userId: string,
    mailboxId: string,
    leaseToken: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.jobClaims.whileLeaseHeld(
      JobClaimType.EmailReceiptPoll,
      userId,
      mailboxId,
      leaseToken,
      POLL_LEASE_MS,
      work,
    );
  }

  private async releaseLease(
    userId: string,
    mailboxId: string,
    leaseToken: string,
  ): Promise<void> {
    try {
      await this.jobClaims.releaseLease(
        JobClaimType.EmailReceiptPoll,
        userId,
        mailboxId,
        leaseToken,
      );
    } catch (error) {
      // The lease expires on its own; a failed release costs one quiet tick.
      this.logger.warn(
        `Could not release the receipt poll lease user=${userId} (${describeFailure(error)})`,
      );
    }
  }

  private async pollLeased(
    userId: string,
    mailboxId: string,
    options: { requireEnabled: boolean },
    deadline: number,
  ): Promise<EmailReceiptPollOutcome> {
    let loaded;
    try {
      loaded = await this.mailbox.loadConnection(userId);
    } catch (error) {
      const line = await this.mailbox.recordPollFailure(
        userId,
        mailboxId,
        error,
      );
      return { ...EMPTY, ok: false, error: line };
    }
    if (!loaded || loaded.mailboxId !== mailboxId) return { ...EMPTY };
    if (options.requireEnabled && !loaded.enabled) return { ...EMPTY };

    const outcome: EmailReceiptPollOutcome = { ...EMPTY };
    try {
      const fetched = await this.imap.fetchSince(
        loaded.connection,
        loaded.cursor,
        {
          sinceDate: new Date(Date.now() - FIRST_SYNC_DAYS * DAY_MS),
          maxMessages: this.limits.maxMessages,
          maxBytes: this.limits.maxMessageBytes,
        },
      );
      const stored = await this.ingest(userId, mailboxId, fetched);
      outcome.fetched = stored.stored;
      outcome.skipped = stored.skipped;
      await this.mailbox.recordPollSuccess(userId, mailboxId);
    } catch (error) {
      // The cursor did not move (it moves only in the insert transaction), so
      // the next poll reads the same messages again.
      const line = await this.mailbox.recordPollFailure(
        userId,
        mailboxId,
        error,
        loaded.secrets,
      );
      this.logger.warn(
        `Receipt poll could not read a mailbox user=${userId}: ${line}`,
      );
      outcome.ok = false;
      outcome.error = line;
    }

    // What is stored can be processed whether or not the mailbox answered.
    await this.processStored(
      userId,
      mailboxId,
      loaded.aiMode,
      outcome,
      deadline,
    );
    return outcome;
  }

  /** Pending emails, the re-match and the automatic AI step; `outcome.processed` counts. */
  private async processStored(
    userId: string,
    mailboxId: string,
    aiMode: EmailReceiptAiMode,
    outcome: EmailReceiptPollOutcome,
    deadline: number,
  ): Promise<void> {
    const budget = { remaining: AI_CATEGORY_CALLS_PER_POLL };
    const seen = new Set<string>();
    for (const id of await this.selectPending(userId, mailboxId)) {
      if (Date.now() > deadline) break;
      seen.add(id);
      await this.processOne(userId, id, ["pending"], outcome, budget);
    }
    for (const id of await this.selectRematch(userId, mailboxId)) {
      if (Date.now() > deadline) break;
      if (seen.has(id)) continue;
      await this.processOne(
        userId,
        id,
        ["unmatched", "review"],
        outcome,
        budget,
      );
    }

    if (aiMode === "automatic" && Date.now() <= deadline) {
      try {
        await this.ai.runAutomaticStep(userId, { deadline });
      } catch (error) {
        this.logger.warn(
          `Receipt AI step failed user=${userId} (${describeFailure(error)})`,
        );
      }
    }
  }

  /**
   * Store the messages and move the cursor in ONE transaction (INV-RECEIPT-002):
   * a failure anywhere rolls both back and the next poll reads the same UIDs; a
   * UID stored already is skipped by `ON CONFLICT DO NOTHING`. A message that is
   * too large or cannot be decoded is stored `skipped` so its UID is consumed.
   */
  private async ingest(
    userId: string,
    mailboxId: string,
    fetched: FetchSinceResult,
  ): Promise<{ stored: number; skipped: number }> {
    const now = new Date();
    const ownAddresses = ownAddressesOnce(() =>
      withScopedDb(this.dataSource, (m) => loadOwnAddresses(m, userId)),
    );
    const rows: ReceiptRow[] = [];
    for (const message of fetched.messages) {
      rows.push(
        await buildReceiptRow(
          message.source,
          message.uid,
          message.internalDate,
          now,
          ownAddresses,
        ),
      );
    }
    for (const skipped of fetched.skipped) {
      rows.push(skippedRow(skipped.uid, skipped.reason, now));
    }
    return withScopedDb(this.dataSource, async (m) => {
      const { stored, skipped } = await insertReceiptRows(
        m,
        userId,
        mailboxId,
        fetched.uidValidity,
        rows,
      );
      await this.mailbox.advanceCursor(userId, mailboxId, {
        uidValidity: fetched.uidValidity,
        lastUid: fetched.highestUid,
      });
      return { stored, skipped };
    });
  }

  private async processOne(
    userId: string,
    receiptId: string,
    statuses: readonly EmailReceiptStatus[],
    outcome: EmailReceiptPollOutcome,
    budget: { remaining: number },
  ): Promise<void> {
    try {
      const result = await this.pipeline.process(userId, receiptId, {
        onlyWhenStatusIn: statuses,
        aiCategoryBudget: budget,
      });
      if (!result.unchanged) outcome.processed++;
    } catch (error) {
      this.logger.warn(
        `Receipt ${receiptId} could not be processed (${describeFailure(error)})`,
      );
    }
  }

  private async selectPending(
    userId: string,
    mailboxId: string,
  ): Promise<string[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT id
             FROM email_receipts
            WHERE user_id = $1
              AND mailbox_id = $2
              AND status = 'pending'
            ORDER BY received_at DESC, id
            LIMIT $3`,
          [userId, mailboxId, MAX_PROCESSED_PER_POLL],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }

  /**
   * Emails worth another look: `unmatched` ones that arrived in the last 30
   * days (the bank transaction usually arrives later than the email), and
   * `review` ones that stand behind no transaction or behind a request that no
   * longer exists (a restore). A request that was dismissed, expired or applied
   * still exists and is left alone. A trade email is never one: it stands behind
   * no bank transaction by design, and its proposal is the person's to approve.
   */
  private async selectRematch(
    userId: string,
    mailboxId: string,
  ): Promise<string[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT r.id
             FROM email_receipts r
            WHERE r.user_id = $1
              AND r.mailbox_id = $2
              AND (
                (r.status = 'unmatched'
                  AND r.received_at > CURRENT_TIMESTAMP - ($4::int * INTERVAL '1 day'))
                OR (r.status = 'review'
                  -- A trade email has no bank transaction by design and its
                  -- outcome lives on its own request: not a lost match.
                  AND r.trade IS NULL
                  AND NOT EXISTS (
                        SELECT 1
                          FROM ai_review_requests t
                         WHERE t.id = r.ai_review_request_id
                           AND t.user_id = r.user_id
                           AND t.kind = 'email_trade')
                  AND (r.transaction_id IS NULL
                       OR NOT EXISTS (
                            SELECT 1
                              FROM ai_review_requests q
                             WHERE q.id = r.ai_review_request_id
                               AND q.user_id = r.user_id)))
              )
            ORDER BY r.received_at DESC, r.id
            LIMIT $3`,
          [userId, mailboxId, MAX_REMATCHED_PER_POLL, REMATCH_DAYS],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }
}
