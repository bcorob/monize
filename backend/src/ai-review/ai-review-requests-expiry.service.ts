import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { AiReviewNotificationService } from "./ai-review-notification.service";
import { AiReviewRequestsService } from "./ai-review-requests.service";

/** How long an agent may hold a claim before the request goes back to the queue. */
export const AI_REVIEW_CLAIM_TIMEOUT_MINUTES = 60;

/** Claims released per statement; a larger backlog is taken up by the next loop pass. */
export const AI_REVIEW_RELEASE_BATCH = 1000;

/** Passes one run may make, so a run is bounded whatever the backlog. */
export const AI_REVIEW_RELEASE_MAX_BATCHES = 50;

/**
 * Hourly upkeep of the AI review queue, across every user.
 *
 * 1. Requests past `expires_at` in any open state become `expired`
 *    (`AiReviewRequestsService.expireStale`, the same single conditional
 *    UPDATE, which `claimNext` already treats as authoritative by comparing
 *    `expires_at` in the database's clock).
 * 2. A request still `claimed` after `AI_REVIEW_CLAIM_TIMEOUT_MINUTES` goes back
 *    to `pending` with the claim cleared, so an agent that crashed between
 *    claiming and proposing does not hold a request until it expires. An agent
 *    that was only slow finds its later proposal refused, because the
 *    transition is conditional on `status = 'claimed'`, and claims again.
 *
 * 3. `AiReviewNotificationService.notifyReady` tells each user whose count of
 *    open proposals grew (docs/specs/ai-review-notifications.md section 3).
 *
 * Expiry runs first, so a request past its life is never resurrected. Both
 * cutoffs are `CURRENT_TIMESTAMP` in the database, never a clock this process
 * holds, and both are conditional on the stored status, so every replica firing
 * this cron (`docs/cron-jobs.md`) touches the same rows and the losers touch
 * none; `FOR UPDATE SKIP LOCKED` keeps two of them from waiting on one another.
 * No request stands behind a cron and the rows belong to every user, so it runs
 * under `withSystemContext`.
 */
@Injectable()
export class AiReviewRequestsExpiryService {
  private readonly logger = new Logger(AiReviewRequestsExpiryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: AiReviewRequestsService,
    private readonly notifications: AiReviewNotificationService,
  ) {}

  @Cron("20 * * * *")
  async sweepQueue(): Promise<{ expired: number; released: number }> {
    let result = { expired: 0, released: 0 };
    try {
      result = await withSystemContext(async () => {
        const expired = await this.requests.expireStale();
        let released = 0;
        for (let i = 0; i < AI_REVIEW_RELEASE_MAX_BATCHES; i += 1) {
          const batch = await this.releaseStaleClaims();
          released += batch;
          if (batch < AI_REVIEW_RELEASE_BATCH) break;
        }
        return { expired, released };
      });
      if (result.expired > 0 || result.released > 0) {
        this.logger.log(
          `AI review queue: expired ${result.expired} request(s), released ` +
            `${result.released} stale claim(s)`,
        );
      }
      // After expiry and release, so an expired request is never counted. It
      // never throws; the guard keeps a notice from ever breaking the sweep.
      await this.notifyReady();
    } catch (error) {
      // Warned and swallowed: every claim path re-checks expiry and status in
      // the database, so nothing depends on this run having happened.
      this.logger.warn(
        `AI review queue sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return result;
  }

  /** The "proposals ready" step: its failure is logged, never the sweep's. */
  private async notifyReady(): Promise<void> {
    try {
      await this.notifications.notifyReady();
    } catch (error) {
      this.logger.warn(
        `AI review ready notices failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** One bounded release in its own transaction; returns the claims released. */
  private releaseStaleClaims(): Promise<number> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE ai_review_requests
              SET status = 'pending',
                  claimed_by = NULL,
                  claimed_at = NULL
            WHERE id IN (
                    SELECT id
                      FROM ai_review_requests
                     WHERE status = 'claimed'
                       AND claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $1)
                       AND expires_at > CURRENT_TIMESTAMP
                     LIMIT $2
                       FOR UPDATE SKIP LOCKED)
              AND status = 'claimed'
           RETURNING id`,
          [AI_REVIEW_CLAIM_TIMEOUT_MINUTES, AI_REVIEW_RELEASE_BATCH],
        ),
      );
      return rows.length;
    });
  }
}
