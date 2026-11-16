import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { numberFormatterFor } from "../common/number-locale.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";

export interface PriceObservation {
  price_date: string;
  close_price: string | number;
}
/** Raw quoted-price change, not total return. No stale or future price alerts. */
export function priceMovement(
  prices: PriceObservation[],
  threshold: number,
  today: string,
): number | null {
  if (
    !Number.isFinite(threshold) ||
    threshold < 0.1 ||
    threshold > 1000 ||
    prices.length !== 2
  )
    return null;
  const [latest, previous] = prices;
  if (latest.price_date !== today || previous.price_date >= today) return null;
  const current = Number(latest.close_price),
    prior = Number(previous.close_price);
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(prior) ||
    current <= 0 ||
    prior <= 0
  )
    return null;
  const percent = ((current - prior) / prior) * 100;
  // Account only for floating-point conversion error at an exact boundary
  // (e.g. 100 -> 100.1 at 0.1%), not a business-level rounding tolerance.
  const tolerance =
    ((4 * Number.EPSILON * Math.max(current, prior)) / prior) * 100;
  return Number.isFinite(percent) && Math.abs(percent) + tolerance >= threshold
    ? percent
    : null;
}

@Injectable()
export class SecurityPriceAlertService {
  private readonly logger = new Logger(SecurityPriceAlertService.name);
  private running = false;
  constructor(
    private readonly db: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  // Reads stored quotes; never calls an external provider. Keyset batches bound
  // each query, and the notification write door deduplicates competing replicas.
  @Cron("*/15 * * * *")
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const today = new Date().toISOString().slice(0, 10);
    try {
      let after = "00000000-0000-0000-0000-000000000000";
      for (;;) {
        const rows: { id: string; user_id: string }[] = await withSystemContext(
          () =>
            withScopedDb(this.db, (m) =>
              m.query(
                `SELECT id, user_id FROM securities WHERE id > $1 AND is_active = true
             AND price_alert_percent IS NOT NULL ORDER BY id LIMIT 100`,
                [after],
              ),
            ),
        );
        if (!rows.length) break;
        for (const row of rows) {
          try {
            await withUserContext(row.user_id, () =>
              this.evaluate(row.user_id, row.id, today),
            );
          } catch (error) {
            this.logger.warn(
              `Price alert evaluation failed for ${row.id}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
        }
        after = rows[rows.length - 1].id;
      }
    } catch (error) {
      this.logger.error(
        "Price alert scan failed",
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }

  async evaluate(
    userId: string,
    securityId: string,
    today: string,
  ): Promise<void> {
    const snapshot = await withScopedDb(this.db, async (m) => {
      // Re-read owner and opt-in under the user's scope, even if RLS is disabled.
      const securities = await m.query(
        `SELECT symbol, currency_code, price_alert_percent FROM securities
         WHERE id = $1 AND user_id = $2 AND is_active = true AND price_alert_percent IS NOT NULL`,
        [securityId, userId],
      );
      if (!securities[0]) return null;
      const prices: PriceObservation[] = await m.query(
        `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS price_date, close_price
         FROM security_prices WHERE security_id = $1 AND price_date <= $2::date
         ORDER BY price_date DESC LIMIT 2`,
        [securityId, today],
      );
      return { security: securities[0], prices };
    });
    if (!snapshot) return;
    const { security, prices } = snapshot;
    const changePercent = priceMovement(
      prices,
      Number(security.price_alert_percent),
      today,
    );
    if (changePercent === null) return;
    // Only now that there is something to say, and in its own short read: the
    // stored English `title`/`message` below is what `notificationEmailCopy`
    // falls back to WHOLE for a row it cannot rebuild, and an email renders that
    // fallback to this person -- so the percentage inside it follows their
    // number locale, not the server's (issue #1316). Most evaluations return
    // above, so the scan pays for this read only when it alerts.
    const prefs = await withScopedDb(this.db, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);
    const shownPercent = n.formatPercent(changePercent, 2);
    await this.dispatch.notify(
      userId,
      {
        type: NotificationType.SECURITY_PRICE_MOVEMENT,
        severity: NotificationSeverity.INFO,
        title: `${security.symbol}: ${shownPercent}`,
        message: `${security.symbol}: ${shownPercent} since the previous available session.`,
        target: `/securities/${securityId}`,
        dedupeKey: `security-price:${securityId}:${today}`,
        periodStart: today,
        data: {
          securityId,
          symbol: security.symbol,
          currencyCode: security.currency_code,
          changePercent: Number(changePercent.toFixed(4)),
          priceDate: today,
          previousDate: prices[1].price_date,
          price: Number(prices[0].close_price),
          previousPrice: Number(prices[1].close_price),
        },
      },
      { collapseKey: `security-price:${securityId}` },
    );
  }
}
