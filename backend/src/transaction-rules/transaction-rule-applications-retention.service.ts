import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { affectedRowCount } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";

/** How long a rule application (the audit trail of what a rule changed) is kept. */
export const RULE_APPLICATION_RETENTION_DAYS = 365;

/** Rows removed per statement, so no single transaction holds a long lock. */
export const RULE_APPLICATION_DELETE_BATCH = 5000;

/**
 * Batches one run may issue. A backlog larger than this many batches is taken
 * up by the next day's run, so a first run over years of rows cannot occupy the
 * database indefinitely.
 */
export const RULE_APPLICATION_MAX_BATCHES = 200;

/**
 * Daily retention for `transaction_rule_applications`.
 *
 * Each row records what one rule changed on one transaction (before/after per
 * field) and is written on every match, so the table only ever grows. A row
 * past the retention window is history nobody reads, and nothing else depends
 * on it.
 *
 * The cutoff is `CURRENT_TIMESTAMP` in the database, never a `Date` this
 * process computed: every replica fires this cron (`docs/cron-jobs.md`), and
 * the earliest local clock would otherwise delete a row a later one still
 * retains. Each batch is its own transaction; `FOR UPDATE SKIP LOCKED` lets two
 * replicas working the same backlog take disjoint rows instead of waiting on
 * one another, and a run that finds nothing is a no-op, so a second replica
 * (or a second run) is harmless.
 *
 * The rows belong to every user at once and no request stands behind a cron, so
 * it runs under `withSystemContext`.
 */
@Injectable()
export class TransactionRuleApplicationsRetentionService {
  private readonly logger = new Logger(
    TransactionRuleApplicationsRetentionService.name,
  );

  constructor(private readonly dataSource: DataSource) {}

  @Cron("45 3 * * *")
  async purgeExpiredApplications(): Promise<number> {
    let total = 0;
    try {
      total = await withSystemContext(async () => {
        let deleted = 0;
        for (let i = 0; i < RULE_APPLICATION_MAX_BATCHES; i += 1) {
          const batch = await this.deleteBatch();
          deleted += batch;
          if (batch < RULE_APPLICATION_DELETE_BATCH) break;
        }
        return deleted;
      });
      if (total > 0) {
        this.logger.log(
          `Deleted ${total} rule application(s) older than ` +
            `${RULE_APPLICATION_RETENTION_DAYS} days`,
        );
      }
    } catch (error) {
      // Warned and swallowed, like the other retention sweeps: nothing depends
      // on this run, and a throw out of a cron handler is an unhandled
      // rejection rather than a report anyone reads.
      this.logger.warn(
        `Rule application retention failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return total;
  }

  /** One bounded delete in its own transaction; returns the rows removed. */
  private deleteBatch(): Promise<number> {
    return withScopedDb(this.dataSource, async (manager) =>
      affectedRowCount(
        await manager.query(
          `DELETE FROM transaction_rule_applications
            WHERE id IN (
                    SELECT id
                      FROM transaction_rule_applications
                     WHERE applied_at < CURRENT_TIMESTAMP - make_interval(days => $1)
                     LIMIT $2
                       FOR UPDATE SKIP LOCKED)`,
          [RULE_APPLICATION_RETENTION_DAYS, RULE_APPLICATION_DELETE_BATCH],
        ),
      ),
    );
  }
}
