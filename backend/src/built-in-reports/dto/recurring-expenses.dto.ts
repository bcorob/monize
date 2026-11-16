import { ApiProperty } from "@nestjs/swagger";

export const RECURRING_EXPENSE_FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "OCCASIONAL",
  "IRREGULAR",
] as const;

export type RecurringExpenseFrequency =
  (typeof RECURRING_EXPENSE_FREQUENCIES)[number];

/**
 * The look-back windows the analysis accepts, ending today. `all` has no lower
 * bound. The default, `6m`, is the window the report has always used.
 */
export const RECURRING_EXPENSE_RANGES = [
  "6m",
  "1y",
  "2y",
  "5y",
  "all",
] as const;

export type RecurringExpenseRange = (typeof RECURRING_EXPENSE_RANGES)[number];

export const DEFAULT_RECURRING_EXPENSE_RANGE: RecurringExpenseRange = "6m";

export function isRecurringExpenseRange(
  value: unknown,
): value is RecurringExpenseRange {
  return (
    typeof value === "string" &&
    (RECURRING_EXPENSE_RANGES as readonly string[]).includes(value)
  );
}

export class RecurringExpenseItem {
  @ApiProperty()
  payeeName: string;

  @ApiProperty({ nullable: true })
  payeeId: string | null;

  @ApiProperty()
  occurrences: number;

  @ApiProperty()
  totalAmount: number;

  @ApiProperty()
  averageAmount: number;

  @ApiProperty({ example: "2025-01-15" })
  lastTransactionDate: string;

  @ApiProperty({ enum: RECURRING_EXPENSE_FREQUENCIES })
  frequency: RecurringExpenseFrequency;

  @ApiProperty({ nullable: true })
  categoryName: string | null;
}

export class RecurringSummary {
  @ApiProperty({
    nullable: true,
    description:
      "Total of the recurring payees, or null when a row could not be converted into the report currency (a missing rate makes it unknowable, never smaller); knownTotalRecurring carries the part that converted",
  })
  totalRecurring: number | null;

  @ApiProperty({
    description:
      "The part of totalRecurring that converted; a subtotal whenever missingCurrencies is non-empty",
  })
  knownTotalRecurring: number;

  @ApiProperty({
    nullable: true,
    description:
      "totalRecurring spread over the months the window covers (monthCount); null whenever totalRecurring is",
  })
  monthlyEstimate: number | null;

  @ApiProperty({
    description:
      "The same spread over knownTotalRecurring; a subtotal whenever missingCurrencies is non-empty",
  })
  knownMonthlyEstimate: number;

  @ApiProperty({
    description:
      "Months the estimate is spread over: the preset's length, capped at the months of the user's spending history; for `all`, that history (at least 1)",
  })
  monthCount: number;

  @ApiProperty()
  uniquePayees: number;
}

export class RecurringExpensesResponse {
  @ApiProperty({ type: [RecurringExpenseItem] })
  data: RecurringExpenseItem[];

  @ApiProperty({ type: RecurringSummary })
  summary: RecurringSummary;

  /** Reporting currency every amount above is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}. A payee's
   * `totalAmount` is only the part that converted when this is non-empty.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}
