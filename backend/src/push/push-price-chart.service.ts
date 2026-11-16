import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { isUUID } from "class-validator";
import { withScopedDb } from "../common/db/scoped-db";
import { PushChartArtifactService } from "./push-chart-artifact.service";
import { renderPriceChart, CHART_MAX_POINTS } from "./price-chart-png";

export interface PriceChartRequest {
  securityId: string;
  priceDate: string;
  price: number;
}
/** Stored notification data is untrusted (including restored rows). */
export function priceChartRequest(
  data: unknown,
): PriceChartRequest | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (
    typeof d.securityId !== "string" ||
    !isUUID(d.securityId) ||
    typeof d.priceDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.priceDate) ||
    !Number.isFinite(Date.parse(d.priceDate)) ||
    new Date(d.priceDate).toISOString().slice(0, 10) !== d.priceDate ||
    typeof d.price !== "number" ||
    !Number.isFinite(d.price) ||
    d.price <= 0 ||
    d.price > 1e14
  )
    return undefined;
  return { securityId: d.securityId, priceDate: d.priceDate, price: d.price };
}

@Injectable()
export class PushPriceChartService {
  private readonly logger = new Logger(PushPriceChartService.name);
  constructor(
    private readonly db: DataSource,
    private readonly artifacts: PushChartArtifactService,
  ) {}

  async render(
    userId: string,
    request: PriceChartRequest,
  ): Promise<Buffer | null> {
    const r = priceChartRequest(request);
    if (!r) return null;
    try {
      const prices = await withScopedDb(this.db, async (m) => {
        const owners = await m.query(
          `SELECT id FROM securities WHERE id = $1 AND user_id = $2
          AND is_active = true AND price_chart_enabled = true AND price_alert_percent IS NOT NULL`,
          [r.securityId, userId],
        );
        if (!owners.length) return [];
        return m.query(
          `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS date, close_price AS close
          FROM security_prices WHERE security_id = $1 AND price_date < $2::date
          ORDER BY price_date DESC LIMIT $3`,
          [r.securityId, r.priceDate, CHART_MAX_POINTS - 1],
        );
      });
      if (!prices.length) return null;
      // Preserve the alert's quoted close even if the provider updates it later.
      return renderPriceChart([
        ...prices.reverse().map((p: { date: string; close: string }) => ({
          date: p.date,
          close: Number(p.close),
        })),
        { date: r.priceDate, close: r.price },
      ]);
    } catch {
      this.logger.warn("Push chart rendering failed; sending text only");
      return null;
    }
  }
  async issue(png: Buffer): Promise<string | null> {
    try {
      return await this.artifacts.issue(png);
    } catch {
      this.logger.warn("Push chart storage failed; sending text only");
      return null;
    }
  }
}
