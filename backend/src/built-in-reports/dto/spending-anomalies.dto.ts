export type AnomalyType =
  "large_transaction" | "category_spike" | "unusual_payee";
export type AnomalySeverity = "high" | "medium" | "low";

export class SpendingAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  amount?: number;
  transactionId?: string;
  transactionDate?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  currentPeriodAmount?: number;
  previousPeriodAmount?: number;
  percentChange?: number;
}

export class AnomalyStatistics {
  mean: number;
  stdDev: number;
}

export class AnomalyCounts {
  high: number;
  medium: number;
  low: number;
}

export class SpendingAnomaliesResponse {
  /**
   * Mean and standard deviation over the transactions that converted into
   * {@link currency}; a transaction whose currency had no rate is in neither,
   * in no anomaly and in no category or payee total.
   */
  statistics: AnomalyStatistics;
  anomalies: SpendingAnomaly[];
  counts: AnomalyCounts;

  /** Reporting currency every amount above is expressed in. */
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}. Empty when the
   * analysis covered every transaction.
   */
  missingCurrencies: string[];

  /** How many transactions were left out because their currency had no rate. */
  excludedCount: number;
}
