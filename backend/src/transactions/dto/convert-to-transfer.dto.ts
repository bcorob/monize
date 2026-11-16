import { OmitType } from "@nestjs/swagger";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from "class-validator";
import { CreateTransferDto } from "./create-transfer.dto";

/**
 * The transfer an existing transaction becomes (`POST
 * /transactions/:id/convert-to-transfer`): the create's body, less the
 * idempotency key. The row being converted already has an `externalId` or
 * none, set by the create that wrote it, and a conversion must not let a retry
 * of that create miss its row.
 *
 * `tagIds` is declared again here, bounded: the create's own list predates the
 * array-bound guard and is grandfathered there, and a mapped type inherits its
 * validators without the grandfathering (`array-bound-dto.spec.ts`).
 */
export class ConvertToTransferDto extends OmitType(CreateTransferDto, [
  "externalId",
  "tagIds",
] as const) {
  @ApiPropertyOptional({
    description:
      "Tag IDs applied to both legs; omitted keeps the row's tags and mirrors them onto the new leg",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("4", { each: true })
  tagIds?: string[];
}
