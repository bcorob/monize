import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from "class-validator";
import {
  LOAN_SETTLEMENT_EXCESS_POLICIES,
  LOAN_SETTLEMENT_SHORTFALL_POLICIES,
} from "../../transaction-rules/rule-action.types";

/** Length of a payment-matching pattern (`matches` leaf, glob). */
export const MIN_PAYMENT_MATCHING_PATTERN_LENGTH = 1;
export const MAX_PAYMENT_MATCHING_PATTERN_LENGTH = 200;

/** A glob the rule engine answers against the whole text needs a wildcard. */
const GLOB_WILDCARD = /\*/;

/**
 * The "Payment matching" section of the mortgage form, the loan-payment setup
 * dialog and the Loan Details panel (`docs/specs/loan-installment-settlement.md`
 * decision 5). The source account is the loan's scheduled payment's, never
 * this request's; the rule built from it is `LoanPaymentMatchingService`'s.
 */
export class PaymentMatchingDto {
  @ApiProperty({
    example: "ING HYPOTHEKEN*",
    description:
      "Glob over the bank row's payee text, matched against the whole text: `*` is any run of characters, so it must contain at least one",
    minLength: MIN_PAYMENT_MATCHING_PATTERN_LENGTH,
    maxLength: MAX_PAYMENT_MATCHING_PATTERN_LENGTH,
  })
  @IsString()
  @Length(
    MIN_PAYMENT_MATCHING_PATTERN_LENGTH,
    MAX_PAYMENT_MATCHING_PATTERN_LENGTH,
  )
  @Matches(GLOB_WILDCARD, {
    message: "payeePattern must contain a * wildcard",
  })
  payeePattern: string;

  @ApiPropertyOptional({
    example: "*Hypotheek*",
    description:
      "Optional glob over the bank row's description, matched against the whole text; must contain at least one `*`",
    minLength: MIN_PAYMENT_MATCHING_PATTERN_LENGTH,
    maxLength: MAX_PAYMENT_MATCHING_PATTERN_LENGTH,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsString()
  @Length(
    MIN_PAYMENT_MATCHING_PATTERN_LENGTH,
    MAX_PAYMENT_MATCHING_PATTERN_LENGTH,
  )
  @Matches(GLOB_WILDCARD, {
    message: "descriptionPattern must contain a * wildcard",
  })
  descriptionPattern?: string | null;

  @ApiPropertyOptional({
    enum: LOAN_SETTLEMENT_EXCESS_POLICIES,
    default: "extra_principal",
    description:
      "A row that paid more than the priced installment: book the difference as extra principal, or refuse it",
  })
  @IsOptional()
  @IsIn(LOAN_SETTLEMENT_EXCESS_POLICIES)
  excess?: (typeof LOAN_SETTLEMENT_EXCESS_POLICIES)[number];

  @ApiPropertyOptional({
    enum: LOAN_SETTLEMENT_SHORTFALL_POLICIES,
    default: "refuse",
    description:
      "A row that paid less than the priced installment: refuse it, or pay the interest first and the rest as principal",
  })
  @IsOptional()
  @IsIn(LOAN_SETTLEMENT_SHORTFALL_POLICIES)
  shortfall?: (typeof LOAN_SETTLEMENT_SHORTFALL_POLICIES)[number];
}

/** Why a create or setup that saved the loan could not create its rule. */
export class PaymentMatchingFailureDto {
  @ApiProperty({
    example: "RULE_LIMIT_REACHED",
    description:
      "The refusal's errorCode, or PAYMENT_MATCHING_FAILED when it had none",
  })
  errorCode: string;

  @ApiProperty({ description: "The refusal, in the caller's language" })
  message: string;
}

/** One installment a payment-matching rule settled (a `rule` claim). */
export class LoanSettlementResponseDto {
  @ApiProperty({ description: "The claim (scheduled_transaction_postings) id" })
  claimId: string;

  @ApiProperty({
    example: "2024-01-01",
    description: "The occurrence the row paid (YYYY-MM-DD)",
  })
  dueDate: string;

  @ApiProperty({
    example: "2024-01-03",
    description: "The settled row's date (YYYY-MM-DD)",
  })
  postedDate: string;

  @ApiProperty({ description: "The settled bank row" })
  transactionId: string;

  @ApiProperty({
    example: "UNRECONCILED",
    description: "The settled row's status; a VOID row keeps its claim",
  })
  transactionStatus: string;

  @ApiProperty({ nullable: true, description: "Principal line written" })
  principal: number | null;

  @ApiProperty({ nullable: true, description: "Interest line written" })
  interest: number | null;

  @ApiProperty({
    nullable: true,
    description: "Extra-principal line written (0 when none)",
  })
  extraPrincipal: number | null;

  @ApiProperty({
    nullable: true,
    description: "The debt the installment was priced on",
  })
  debtBefore: number | null;

  @ApiProperty({
    nullable: true,
    description: "The installment's number on the schedule's calendar",
  })
  installmentNumber: number | null;

  @ApiProperty({
    nullable: true,
    description: "The rule that settled it; null once that rule is deleted",
  })
  ruleId: string | null;
}
