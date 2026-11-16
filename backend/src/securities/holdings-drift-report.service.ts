import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { HoldingsService } from "./holdings.service";

/**
 * A boot-time, read-only report of holdings that disagree with the ledger.
 *
 * `holdings.quantity` and `average_cost` are now written only by a fold over
 * the ledger (INV-HOLDING-001). Rows written by the incremental maintainer that
 * preceded it can still be wrong, and nothing in the database says which they
 * are: an average cost is a bare number with no record of how it was arrived
 * at. This finds them and says so.
 *
 * **It never writes.** No migration, no automatic rebuild, no delete. A rebuild
 * is destructive in the sense that matters -- it replaces a figure a person may
 * have reconciled against a statement -- and doing it unattended to every user
 * at boot would repair drift and silently overwrite anything else the replay
 * disagrees with, including an incomplete imported history. The repair is
 * `POST /holdings/rebuild`, named in every line this logs, run by the owner
 * once they have seen what would change.
 *
 * Bounded by construction: one query per user with an investment account, and
 * users with no stored holdings cost one `find` and stop
 * (`findLedgerDiscrepancies` returns early). Failures are logged and swallowed
 * -- a diagnostic must not stop the application booting.
 */
@Injectable()
export class HoldingsDriftReportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HoldingsDriftReportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly holdingsService: HoldingsService,
  ) {}

  onApplicationBootstrap(): void {
    // Deliberately not awaited: boot does not wait on a diagnostic.
    void this.reportDiscrepancies().catch((error: unknown) => {
      this.logger.warn(
        `Holdings discrepancy report did not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /**
   * Enumerate every user holding a position, then compare each one's stored
   * rows against a replay of their own ledger.
   *
   * The enumeration is genuinely cross-user, so it runs under
   * `withSystemContext`; each user's comparison runs under that user's own
   * identity, which is what makes the replay it reports the one that user's
   * own rebuild would perform.
   */
  async reportDiscrepancies(): Promise<number> {
    const userIds = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (m) => {
        const rows: { user_id: string }[] = await m.query(
          `SELECT DISTINCT a.user_id
             FROM holdings h
             JOIN accounts a ON a.id = h.account_id
            ORDER BY a.user_id`,
        );
        return rows.map((r) => r.user_id);
      }),
    );

    let reported = 0;
    for (const userId of userIds) {
      // Per user, so one user's unreadable data cannot stop the rest of the
      // report.
      try {
        const discrepancies = await withUserContext(userId, () =>
          withScopedDb(this.dataSource, (m) =>
            this.holdingsService.findLedgerDiscrepancies(userId, m),
          ),
        );
        for (const d of discrepancies) {
          reported++;
          this.logger.warn(
            `Stored holding disagrees with the ledger replay: user ${userId}, ` +
              `account ${d.accountId}, security ${d.securityId}: stored ` +
              `quantity ${d.storedQuantity} at average cost ` +
              `${d.storedAverageCost ?? "(none)"}, replay gives quantity ` +
              `${d.replayedQuantity ?? "(no shares)"} at average cost ` +
              `${d.replayedAverageCost ?? "(none)"}. Repair with ` +
              `POST /holdings/rebuild as this user; nothing has been changed.`,
          );
        }
      } catch (error: unknown) {
        this.logger.warn(
          `Could not compare holdings for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (reported > 0) {
      this.logger.warn(
        `Holdings discrepancy report: ${reported} position(s) disagree with ` +
          `the ledger. Nothing was written.`,
      );
    }
    return reported;
  }
}
