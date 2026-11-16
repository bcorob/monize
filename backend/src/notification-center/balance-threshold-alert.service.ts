import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";
import { CreateNotificationInput } from "./notification.service";

/** The row a fire CAS returns -- the crossing it just armed. */
interface FiredBalanceRow {
  current_balance: string;
  threshold: string;
  currency_code: string;
  name: string;
}

/**
 * Raises a notification when an account's balance crosses a user-set threshold
 * (`docs/specs/balance-threshold-notifications.md`). Event-driven: called from
 * the post-commit balance-invalidation seam
 * (`NetWorthService.triggerDebouncedRecalc`) with the accounts whose balance
 * moved, so it runs after the write commits and never blocks it
 * (INV-BALANCE-006).
 *
 * The crossing rule is a durable armed latch flipped by a compare-and-set: the
 * fire UPDATE arms the latch only when it also finds it un-armed and the balance
 * on the alerting side, and returns the row it armed -- so a crossing fires
 * exactly once even under concurrent evaluation and at-least-once triggering
 * (INV-BALANCE-002). No dedupe key: a `budget_id`-NULL notification row is
 * unconstrained by both unique indexes, so the latch is the idempotency
 * mechanism.
 */
@Injectable()
export class BalanceThresholdAlertService {
  private readonly logger = new Logger(BalanceThresholdAlertService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Evaluate every named account for a low/high crossing. Seeds its own user
   * context (it runs on a background timer with no request); each account is
   * independent, so one failure does not stop the rest.
   */
  async evaluateAccounts(userId: string, accountIds: string[]): Promise<void> {
    if (accountIds.length === 0) return;
    await withUserContext(userId, async () => {
      for (const accountId of accountIds) {
        try {
          await this.evaluateAccount(userId, accountId);
        } catch (error) {
          this.logger.warn(
            `Balance-threshold evaluation failed for account ${accountId}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
    });
  }

  private async evaluateAccount(
    userId: string,
    accountId: string,
  ): Promise<void> {
    // Arm/re-arm the latches in one transaction and collect the crossings that
    // fired; dispatch AFTER it commits. `dispatch.notify` writes the row in its
    // own transaction and then awaits the push/email fan-out -- an external side
    // effect -- and its own contract says to call it OUTSIDE any transaction
    // whose failure it would report. Called from inside this `withScopedDb`, its
    // nested transaction would join this one, so the fan-out would run before
    // the commit AND while the CAS `UPDATE accounts` row lock is held across the
    // push HTTP; a rollback after a fire would then leave a delivered push with
    // no committed row and re-fire the crossing. The latch is the idempotency
    // mechanism (INV-BALANCE-002), so it commits first as the durable claim.
    const fired = await withScopedDb(this.dataSource, async (manager) => {
      const crossings: Array<{ row: FiredBalanceRow; kind: "low" | "high" }> =
        [];
      const low = await this.claimLow(manager, userId, accountId);
      if (low) crossings.push({ row: low, kind: "low" });
      else await this.rearmLow(manager, userId, accountId);
      const high = await this.claimHigh(manager, userId, accountId);
      if (high) crossings.push({ row: high, kind: "high" });
      else await this.rearmHigh(manager, userId, accountId);
      return crossings;
    });
    for (const { row, kind } of fired) {
      await this.fire(userId, accountId, row, kind);
    }
  }

  /** Arm-and-claim the low latch iff the balance is below the low threshold. */
  private async claimLow(
    manager: EntityManager,
    userId: string,
    accountId: string,
  ): Promise<FiredBalanceRow | null> {
    const rows = returnedRows<FiredBalanceRow>(
      await manager.query(
        `UPDATE accounts
            SET low_alert_armed = true
          WHERE id = $1 AND user_id = $2
            AND low_alert_armed = false
            AND low_balance_threshold IS NOT NULL
            AND current_balance < low_balance_threshold
            AND is_closed = false
        RETURNING current_balance,
                  low_balance_threshold AS threshold,
                  currency_code, name`,
        [accountId, userId],
      ),
    );
    return rows[0] ?? null;
  }

  private async rearmLow(
    manager: EntityManager,
    userId: string,
    accountId: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE accounts
          SET low_alert_armed = false
        WHERE id = $1 AND user_id = $2
          AND low_alert_armed = true
          AND (low_balance_threshold IS NULL
               OR current_balance >= low_balance_threshold)`,
      [accountId, userId],
    );
  }

  /** Arm-and-claim the high latch iff the balance is above the high threshold. */
  private async claimHigh(
    manager: EntityManager,
    userId: string,
    accountId: string,
  ): Promise<FiredBalanceRow | null> {
    const rows = returnedRows<FiredBalanceRow>(
      await manager.query(
        `UPDATE accounts
            SET high_alert_armed = true
          WHERE id = $1 AND user_id = $2
            AND high_alert_armed = false
            AND high_balance_threshold IS NOT NULL
            AND current_balance > high_balance_threshold
            AND is_closed = false
        RETURNING current_balance,
                  high_balance_threshold AS threshold,
                  currency_code, name`,
        [accountId, userId],
      ),
    );
    return rows[0] ?? null;
  }

  private async rearmHigh(
    manager: EntityManager,
    userId: string,
    accountId: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE accounts
          SET high_alert_armed = false
        WHERE id = $1 AND user_id = $2
          AND high_alert_armed = true
          AND (high_balance_threshold IS NULL
               OR current_balance <= high_balance_threshold)`,
      [accountId, userId],
    );
  }

  private async fire(
    userId: string,
    accountId: string,
    row: FiredBalanceRow,
    kind: "low" | "high",
  ): Promise<void> {
    await this.dispatch.notify(
      userId,
      buildBalanceNotification(accountId, row, kind),
    );
  }
}

/**
 * The notification a crossing raises, as a pure function of the row and the
 * kind. No dedupe key (the latch is the idempotency mechanism); the balance and
 * currency are a point-in-time snapshot of the crossing, which is what the alert
 * is about.
 */
export function buildBalanceNotification(
  accountId: string,
  row: {
    current_balance: string;
    threshold: string;
    currency_code: string;
    name: string;
  },
  kind: "low" | "high",
): CreateNotificationInput {
  return {
    type:
      kind === "low"
        ? NotificationType.BALANCE_BELOW_THRESHOLD
        : NotificationType.BALANCE_ABOVE_THRESHOLD,
    severity:
      kind === "low" ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
    title:
      kind === "low"
        ? `${row.name} is below its threshold`
        : `${row.name} is above its threshold`,
    message:
      kind === "low"
        ? `${row.name} dropped to ${Number(row.current_balance)} ${row.currency_code}, below your ${Number(row.threshold)} ${row.currency_code} threshold. Open Monize for the details.`
        : `${row.name} rose to ${Number(row.current_balance)} ${row.currency_code}, above your ${Number(row.threshold)} ${row.currency_code} threshold. Open Monize for the details.`,
    data: {
      accountId,
      accountName: row.name,
      balance: Number(row.current_balance),
      threshold: Number(row.threshold),
      currencyCode: row.currency_code,
      kind,
    },
    target: `/accounts/${accountId}`,
    // No dedupeKey -- the latch guarantees one row per crossing (INV-BALANCE-002).
  };
}
