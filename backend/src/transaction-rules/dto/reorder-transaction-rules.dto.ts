import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { MAX_TRANSACTION_RULES_PER_USER } from "../transaction-rules.limits";

export class ReorderTransactionRulesDto {
  @ApiProperty({
    description: "Every rule id of the user, in the new evaluation order",
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(MAX_TRANSACTION_RULES_PER_USER)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  ids: string[];
}
