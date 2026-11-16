import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { BUFFER_TTL_MS } from "./ai-relay.service";
import { RelayAttachmentStore } from "./relay-attachment.store";

/**
 * How long a terminal (`expired`) turn is kept before its row goes.
 *
 * Twice the answer's grace, so the delete's cutoff is strictly later than the
 * expiry's: a row that this sweep marks `expired` survives at least until the
 * next one. A turn's evidence -- whether an agent ever claimed it -- is what
 * decides which of two messages the browser is shown, and deleting the row in
 * the same tick that expired it would throw that away at the boundary.
 */
const RETAIN_EXPIRED_MS = 2 * BUFFER_TTL_MS;
import { withScopedDb } from "../../common/db/scoped-db";
import { withSystemContext } from "../../common/db/with-context";
import { affectedRowCount } from "../../common/db/query-result";

/**
 * Collection of the relay's dead rows.
 *
 * Nothing the relay does depends on this run. A turn past its deadline is
 * already unclaimable and unanswerable -- every statement in `AiRelayService`
 * compares against `expires_at` in the database's clock -- and a card past
 * `expires_at` is already filtered out of the drain. The sweep exists because
 * four tables would otherwise be append-only: a browser that never comes back
 * for its answer, an agent that never returns for its turn, a card nobody
 * approves and a file uploaded with a prompt that was never claimed all leave a
 * row with no later visitor -- and the file leaves bytes behind it.
 *
 * Nothing here reaches outside PostgreSQL, which is why the whole sweep is one
 * transaction: the attachment bytes are a cascading child row rather than an
 * object somebody has to remember to delete afterwards.
 *
 * Idempotent by predicate, so every replica firing this cron
 * (`docs/cron-jobs.md`: they all do, in both cluster modes) touches the same
 * rows and the losers touch none. Deleting late is therefore safe; deleting
 * early would not be, which is why every cutoff is a stored timestamp plus an
 * interval rather than a clock this process holds.
 */
@Injectable()
export class RelaySweeperService {
  private readonly logger = new Logger(RelaySweeperService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly attachments: RelayAttachmentStore,
  ) {}

  @Cron("*/5 * * * *")
  async sweepRelayState(): Promise<void> {
    try {
      const { expired, deleted, cards, files } = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          // A turn nobody claimed, and one an agent claimed and then abandoned
          // for longer than its answer would have been accepted. The grace is
          // the same one `post_response` enforces, so this never closes a turn
          // the agent could still have answered.
          const expiredResult: unknown = await manager.query(
            `UPDATE ai_relay_prompts
                SET status = 'expired'
              WHERE (status = 'pending' AND expires_at <= CURRENT_TIMESTAMP)
                 OR (
                      status IN ('claimed', 'answered')
                      AND GREATEST(expires_at, COALESCE(answered_at, expires_at))
                          + ($1::numeric / 1000 * INTERVAL '1 second')
                          <= CURRENT_TIMESTAMP
                    )`,
            [BUFFER_TTL_MS],
          );
          // Strictly later than the expiry above, and that is the whole point:
          // with the same cutoff this predicate would match every row the
          // statement above had just expired -- both run in one transaction, so
          // the second sees the first's writes -- and a turn would be expired
          // and deleted in the same tick. Keeping the row a while longer is
          // what lets a browser arriving late still read `claimed_at` and be
          // told its assistant went quiet, rather than that no agent ever came.
          const deletedResult: unknown = await manager.query(
            `DELETE FROM ai_relay_prompts
              WHERE status = 'expired'
                AND GREATEST(expires_at, COALESCE(answered_at, expires_at))
                    + ($1::numeric / 1000 * INTERVAL '1 second')
                    <= CURRENT_TIMESTAMP`,
            [RETAIN_EXPIRED_MS],
          );
          const cardResult: unknown = await manager.query(
            `DELETE FROM ai_relay_actions
              WHERE expires_at <= CURRENT_TIMESTAMP`,
          );
          // The bytes are a cascading child row, so this one DELETE takes
          // them: there is no object store to order against and nothing
          // outside PostgreSQL left to leak.
          const files = await this.attachments.sweepExpired(manager);
          return {
            expired: affectedRowCount(expiredResult),
            deleted: affectedRowCount(deletedResult),
            cards: affectedRowCount(cardResult),
            files,
          };
        }),
      );
      if (expired > 0 || deleted > 0 || cards > 0 || files > 0) {
        this.logger.log(
          `Swept relay state: ${expired} turn(s) expired, ${deleted} deleted, ` +
            `${cards} stale confirmation card(s) dropped, ` +
            `${files} attachment(s) reclaimed`,
        );
      }
    } catch (error) {
      // Warned and swallowed, like the other expiry sweeps: nothing depends on
      // this run having happened, and a throw out of a cron handler is an
      // unhandled rejection rather than a report anyone reads.
      this.logger.warn(
        `Relay sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
