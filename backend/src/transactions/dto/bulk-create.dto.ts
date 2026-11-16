import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  ValidateBy,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionDto } from "./create-transaction.dto";
import { CreateTransferDto } from "./create-transfer.dto";

/**
 * The most rows one `POST /transactions/bulk` request may carry. Rows are
 * written one after another, each with its own lookups, rules and read-back,
 * so the cap keeps a full batch well inside a proxy's request timeout; a month
 * of a few hundred rows is two or three requests.
 */
export const BULK_CREATE_MAX_ITEMS = 200;

/**
 * One row of a bulk create: exactly one of `transaction` (the body
 * `POST /transactions` takes) or `transfer` (the body
 * `POST /transactions/transfer` takes). Which one is checked on the list
 * (`EachItemHasOneKind`), because a property validator never runs on an absent
 * property, and a row with neither or both is a malformed request, refused
 * with 400 before any row is written.
 */
export class BulkCreateItemDto {
  @ApiPropertyOptional({
    description: "A transaction, as POST /transactions takes it",
    type: CreateTransactionDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateTransactionDto)
  transaction?: CreateTransactionDto;

  @ApiPropertyOptional({
    description: "A transfer, as POST /transactions/transfer takes it",
    type: CreateTransferDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateTransferDto)
  transfer?: CreateTransferDto;
}

/** True when every item carries exactly one of `transaction` and `transfer`. */
function eachItemHasOneKind(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.every((item: Partial<BulkCreateItemDto> | null) => {
      if (typeof item !== "object" || item === null) return false;
      return (item.transaction == null) !== (item.transfer == null);
    })
  );
}

const EachItemHasOneKind = () =>
  ValidateBy({
    name: "eachItemHasOneKind",
    validator: {
      validate: eachItemHasOneKind,
      defaultMessage: () =>
        "each item in items must carry exactly one of transaction or transfer",
    },
  });

export class BulkCreateTransactionsDto {
  @ApiProperty({
    description: `The rows to create, in order (1 to ${BULK_CREATE_MAX_ITEMS}). Each row is created on its own: one that fails does not undo the others, and the response reports every row by its index. Give every row an externalId: if the response is lost, sending the same batch again answers the rows already made as existing instead of creating them twice.`,
    type: [BulkCreateItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_CREATE_MAX_ITEMS)
  @EachItemHasOneKind()
  @ValidateNested({ each: true })
  @Type(() => BulkCreateItemDto)
  items: BulkCreateItemDto[];
}
