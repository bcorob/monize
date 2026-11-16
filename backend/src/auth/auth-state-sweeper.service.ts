import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { affectedRowCount } from "../common/db/query-result";

/**
 * Daily collection of the three rate-limit and one-shot tables' dead rows.
 *
 * `auth_attempt_counters`, `single_use_tokens` and `http_throttle_counters` are
 * all written on paths that never come back to tidy up: nobody returns to clear
 * a counter for an email address that stopped being attacked, a TOTP code is
 * dead the moment its window passes whether or not anyone tried to reuse it,
 * and a throttler key is one route and one client that may never be seen again.
 * Without a sweep they are append-only.
 *
 * **The sweep is not what makes any of them correct.** An expired counter is
 * already ignored by the incrementing statement, which resets the window in
 * place; a claim against an expired `single_use_tokens` row is still a loss;
 * and a throttler row past its window is reset by its next hit. Deleting late
 * is therefore safe; deleting early would not be, which is why the predicate is
 * the stored expiry and never a clock this process holds.
 *
 * The throttle counters get one extra condition: a key whose window has passed
 * but whose block has not is still serving a refusal, so deleting it would hand
 * a blocked client a clean count. `http_throttle_counters` is `UNLOGGED` and
 * empty in `single`, which makes that delete usually a no-op and never wrong.
 *
 * Idempotent by predicate, so every replica firing this cron
 * (`docs/cron-jobs.md`: they all do, in both cluster modes) deletes the same
 * rows and the losers delete none.
 */
@Injectable()
export class AuthStateSweeperService {
  private readonly logger = new Logger(AuthStateSweeperService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron("0 4 * * *")
  async sweepExpiredAuthState(): Promise<void> {
    try {
      const { counters, tokens, throttles } = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const counterResult: unknown = await manager.query(
            `DELETE FROM auth_attempt_counters
              WHERE window_expires_at < CURRENT_TIMESTAMP`,
          );
          const tokenResult: unknown = await manager.query(
            `DELETE FROM single_use_tokens
              WHERE expires_at < CURRENT_TIMESTAMP`,
          );
          const throttleResult: unknown = await manager.query(
            `DELETE FROM http_throttle_counters
              WHERE window_expires_at < CURRENT_TIMESTAMP
                AND (blocked_until IS NULL OR blocked_until < CURRENT_TIMESTAMP)`,
          );
          return {
            counters: affectedRowCount(counterResult),
            tokens: affectedRowCount(tokenResult),
            throttles: affectedRowCount(throttleResult),
          };
        }),
      );
      if (counters > 0 || tokens > 0 || throttles > 0) {
        this.logger.log(
          `Swept ${counters} expired attempt counter(s), ${tokens} expired ` +
            `single-use token(s) and ${throttles} expired throttle counter(s)`,
        );
      }
    } catch (error) {
      // Warned and swallowed, like the other expiry sweeps: nothing depends on
      // this run having happened, and a throw out of a cron handler is an
      // unhandled rejection rather than a report anyone reads.
      this.logger.warn(
        `Auth state sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
