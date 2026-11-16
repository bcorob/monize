export class BillPaymentItem {
  scheduledTransactionId: string;
  scheduledTransactionName: string;
  payeeName: string;
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  lastPaymentDate: string | null;
}

export class MonthlyBillTotal {
  /**
   * The month as structure (`YYYY-MM`), and the only form it travels in. A
   * `label` field beside it carried an `en-US` `Mmm YY` string, which was
   * English in all 22 locales; the client renders this key through the user's
   * own date preference. Do not add a display string here -- a formatted month
   * on the wire is a month formatted for the wrong reader.
   */
  month: string;
  total: number;
}

export class BillPaymentSummary {
  /**
   * Total paid, or `null` when a payment could not be converted into
   * {@link BillPaymentHistoryResponse.currency} -- a missing rate makes it
   * unknowable, never smaller. `knownTotalPaid` carries the part that converted.
   */
  totalPaid: number | null;
  knownTotalPaid: number;
  totalPayments: number;
  uniqueBills: number;
  /** `null` whenever `totalPaid` is; `knownMonthlyAverage` is the same spread over the known part. */
  monthlyAverage: number | null;
  knownMonthlyAverage: number;
}

export class BillPaymentHistoryResponse {
  /**
   * A payment whose currency had no rate is in none of these figures: it cannot
   * be matched against the bill's amount, so it is neither paid nor missed.
   * Each bill's `totalPaid` and each month's `total` are only the part that
   * converted when `missingCurrencies` is non-empty.
   */
  billPayments: BillPaymentItem[];
  monthlyTotals: MonthlyBillTotal[];
  summary: BillPaymentSummary;

  /** Reporting currency every amount above is expressed in. */
  currency: string;

  /** Source currencies with no usable rate into {@link currency}. */
  missingCurrencies: string[];

  /** How many payments were left out because their currency had no rate. */
  excludedCount: number;
}
