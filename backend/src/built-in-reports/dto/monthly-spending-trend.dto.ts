import { ApiProperty } from "@nestjs/swagger";

export class MonthlyCategorySpending {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Food & Dining" })
  categoryName: string;

  @ApiProperty({ example: "#3b82f6", nullable: true })
  color: string | null;

  @ApiProperty({ example: 500.0 })
  total: number;
}

export class MonthlySpendingItem {
  @ApiProperty({ example: "2024-01" })
  month: string;

  @ApiProperty({ type: [MonthlyCategorySpending] })
  categories: MonthlyCategorySpending[];

  @ApiProperty({ example: 3000.0 })
  totalSpending: number;
}

export class MonthlySpendingTrendResponse {
  /**
   * One entry per month, in {@link currency}. Rows whose currency had no rate
   * are left out of every figure, so when `missingCurrencies` is non-empty a
   * month's `totalSpending` and each category `total` are only the part that
   * converted.
   */
  @ApiProperty({ type: [MonthlySpendingItem] })
  data: MonthlySpendingItem[];

  /** Reporting currency every figure above is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}
