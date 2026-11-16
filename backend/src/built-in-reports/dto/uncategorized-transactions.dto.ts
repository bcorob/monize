import { ApiProperty } from "@nestjs/swagger";

export class UncategorizedTransactionItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  transactionDate: string;

  @ApiProperty({
    description:
      "The amount in currencyCode: converted into the report currency when a rate exists, otherwise the original amount in the row's own currency",
  })
  amount: number;

  @ApiProperty({
    description:
      "The currency amount is in. The report currency when converted; the row's own currency when its currency had no rate. Never the report currency over an unconverted amount",
  })
  currencyCode: string;

  @ApiProperty({ nullable: true })
  payeeName: string | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  accountName: string | null;

  @ApiProperty()
  accountId: string;
}

export class UncategorizedTransactionsSummary {
  @ApiProperty()
  totalCount: number;

  @ApiProperty()
  expenseCount: number;

  @ApiProperty({
    nullable: true,
    description:
      "Total uncategorized expenses, or null when a row could not be converted into currencyCode (a missing rate makes it unknowable, never smaller); knownExpenseTotal carries the part that converted",
  })
  expenseTotal: number | null;

  @ApiProperty({
    description:
      "The part of expenseTotal that converted; a subtotal whenever missingCurrencies is non-empty",
  })
  knownExpenseTotal: number;

  @ApiProperty()
  incomeCount: number;

  @ApiProperty({
    nullable: true,
    description:
      "Total uncategorized income, or null when a row could not be converted into currencyCode; knownIncomeTotal carries the part that converted",
  })
  incomeTotal: number | null;

  @ApiProperty({
    description:
      "The part of incomeTotal that converted; a subtotal whenever missingCurrencies is non-empty",
  })
  knownIncomeTotal: number;

  @ApiProperty()
  currencyCode: string;
}

export class UncategorizedTransactionsResponse {
  @ApiProperty({ type: [UncategorizedTransactionItem] })
  transactions: UncategorizedTransactionItem[];

  @ApiProperty({ type: UncategorizedTransactionsSummary })
  summary: UncategorizedTransactionsSummary;

  /** Reporting currency the summary totals are expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}. Their rows
   * stay in `transactions` (the user still has to file them), in their own
   * currency, and are in no summary total. The counts need no rate and include
   * them.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many summary rows (one per currency group) were left out of the totals. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}
