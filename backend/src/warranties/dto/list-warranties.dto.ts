import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from "../../common/dto/pagination-query.dto";
import { WARRANTY_STATUSES, WarrantyStatus } from "../warranty-status.util";

export type WarrantyStatusFilter = WarrantyStatus | "all";
export const WARRANTY_STATUS_FILTERS: readonly WarrantyStatusFilter[] = [
  ...WARRANTY_STATUSES,
  "all",
];

export type WarrantySort = "expiresOn" | "name" | "purchaseDate";
export const WARRANTY_SORTS: readonly WarrantySort[] = [
  "expiresOn",
  "name",
  "purchaseDate",
];

export type WarrantySortDir = "asc" | "desc";
export const WARRANTY_SORT_DIRS: readonly WarrantySortDir[] = ["asc", "desc"];

/**
 * `GET /warranties`. Every value is a query-string value: a repeated key
 * arrives as an array, which `@IsIn`, `@IsString` and `@IsUUID` refuse rather
 * than coerce. `archived` accepts exactly `true` or `false`.
 */
export class ListWarrantiesDto {
  @ApiPropertyOptional({ enum: WARRANTY_STATUS_FILTERS, default: "all" })
  @IsOptional()
  @IsIn(WARRANTY_STATUS_FILTERS)
  status?: WarrantyStatusFilter;

  @ApiPropertyOptional({
    maxLength: 200,
    description: "Matches name, vendor, model number and serial numbers",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    format: "uuid",
    description: "Only the warranties linked to this transaction",
  })
  @IsOptional()
  @IsUUID()
  transactionId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      "true lists the archived warranties instead of the current ones",
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ enum: WARRANTY_SORTS, default: "expiresOn" })
  @IsOptional()
  @IsIn(WARRANTY_SORTS)
  sort?: WarrantySort;

  @ApiPropertyOptional({
    enum: WARRANTY_SORT_DIRS,
    description:
      "Direction of `sort`; absent keeps the field's own default (name and expiry ascending, purchase date descending)",
  })
  @IsOptional()
  @IsIn(WARRANTY_SORT_DIRS)
  sortDir?: WarrantySortDir;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PAGINATION_MAX_LIMIT,
    default: PAGINATION_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}
