import { ApiProperty } from "@nestjs/swagger";
import {
  IsPositive,
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from "class-validator";
import { InvestmentAction } from "../entities/investment-transaction.entity";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateInvestmentTransactionDto {
  @ApiProperty()
  @IsUUID()
  accountId: string;

  @ApiProperty({ enum: InvestmentAction })
  @IsEnum(InvestmentAction)
  action: InvestmentAction;

  @ApiProperty()
  @IsDateString()
  transactionDate: string;

  @ApiProperty({
    required: false,
    description: "Security ID for buy/sell transactions",
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiProperty({
    required: false,
    description: "Account where funds come from (BUY) or go to (SELL)",
  })
  @IsOptional()
  @IsUUID()
  fundingAccountId?: string;

  @ApiProperty({ required: false, description: "Number of shares" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  quantity?: number;

  @ApiProperty({ required: false, description: "Price per share" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  price?: number;

  @ApiProperty({
    required: false,
    description: "Commission or fee",
    default: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  commission?: number;

  @ApiProperty({
    required: false,
    description:
      "Accrued interest paid out with a REDEEM, recorded as a linked INTEREST transaction and included in the single cash movement. Refused on any other action.",
    default: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  accruedInterest?: number;

  @ApiProperty({
    required: false,
    description:
      "Exchange rate used to convert the total amount from the security's currency into the cash account's currency. If omitted, the most recent market rate is used. Defaults to 1 when both currencies match.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  // Strictly positive: zero is not a rate. `@Min(0)` let a request through that
  // previewed as zero cash impact and committed at 1.0 (audit P5-005).
  @IsPositive()
  exchangeRate?: number;

  @ApiProperty({
    required: false,
    description: "Description of the transaction",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiProperty({
    enum: TransactionStatus,
    required: false,
    description:
      "Reconciliation status. Defaults to UNRECONCILED. A VOID transaction moves no shares and no cash.",
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}
