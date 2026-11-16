import { PartialType } from "@nestjs/swagger";
import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";
import { CreateTransactionRuleDto } from "./create-transaction-rule.dto";

/** `revision` is an INTEGER column. */
const MAX_REVISION = 2147483647;

export class UpdateTransactionRuleDto extends PartialType(
  CreateTransactionRuleDto,
) {
  @ApiProperty({
    description:
      "The revision the client last read; a stale value is refused with 409 and nothing is written",
  })
  @IsInt()
  @Min(1)
  @Max(MAX_REVISION)
  revision: number;
}
