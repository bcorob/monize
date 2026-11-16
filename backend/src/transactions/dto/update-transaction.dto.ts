import { OmitType, PartialType } from "@nestjs/swagger";
import {
  IsOptional,
  IsArray,
  IsDateString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionDto } from "./create-transaction.dto";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";

// `externalId` is set once, by the create that the key makes idempotent; an
// edit that could change it would let a retry of that create miss its row.
export class UpdateTransactionDto extends PartialType(
  OmitType(CreateTransactionDto, ["externalId"] as const),
) {
  @ApiPropertyOptional({
    description: "Splits for split transactions",
    type: [CreateTransactionSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionSplitDto)
  splits?: CreateTransactionSplitDto[];

  @ApiPropertyOptional({
    description:
      "Override the created-at timestamp (ISO 8601). Requires showCreatedAt preference enabled.",
  })
  @IsOptional()
  @IsDateString()
  createdAt?: string;
}
