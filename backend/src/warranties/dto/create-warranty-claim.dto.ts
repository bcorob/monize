import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from "class-validator";

import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import {
  WARRANTY_CLAIM_STATUSES,
  WarrantyClaimStatus,
} from "../entities/warranty-claim.entity";
import { PayloadRule, hasValue, isBlank } from "./create-warranty.dto";

/** The outcomes a claim can be closed with; only these carry `resolvedOn`. */
export const WARRANTY_CLAIM_CLOSED_STATUSES: readonly WarrantyClaimStatus[] = [
  "resolved",
  "denied",
];

/** `resolvedOn` is only a fact about a claim that has an outcome. */
export function resolvedOnFitsStatus(
  resolvedOn: unknown,
  status: unknown,
): boolean {
  return (
    isBlank(resolvedOn) ||
    WARRANTY_CLAIM_CLOSED_STATUSES.includes(status as WarrantyClaimStatus)
  );
}

/**
 * A claim cannot be settled before it was made. Anything that is not two
 * strings is left to the field validators, which report it by name.
 */
export function resolvedOnFitsClaimDate(
  resolvedOn: unknown,
  claimDate: unknown,
): boolean {
  return (
    isBlank(resolvedOn) ||
    typeof resolvedOn !== "string" ||
    typeof claimDate !== "string" ||
    resolvedOn >= claimDate
  );
}

/**
 * Every field a claim's create and update accept, validated one at a time.
 * The rules relating two fields are class-level and differ between the two
 * verbs (an update is checked against the stored row by the service), so they
 * are declared on `CreateWarrantyClaimDto` and `UpdateWarrantyClaimDto`, as
 * `create-warranty.dto.ts` explains.
 *
 * No `userId` and no `warrantyId`: the owner is the JWT's and the warranty is
 * the route's.
 */
export class WarrantyClaimFieldsDto {
  @ApiProperty({ example: "2026-10-21" })
  @IsCalendarDate({
    message: "claimDate must be a real YYYY-MM-DD calendar date",
  })
  claimDate: string;

  @ApiPropertyOptional({ enum: WARRANTY_CLAIM_STATUSES, default: "open" })
  @IsOptional()
  @IsIn(WARRANTY_CLAIM_STATUSES)
  status?: WarrantyClaimStatus;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  resolution?: string | null;

  @ApiPropertyOptional({
    example: "2026-11-02",
    nullable: true,
    description: "Only with a status of resolved or denied",
  })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsCalendarDate({
    message: "resolvedOn must be a real YYYY-MM-DD calendar date",
  })
  resolvedOn?: string | null;
}

/**
 * `POST /warranties/:id/claims`. A claim starts `open` unless the payload
 * says otherwise; a resolution date needs an outcome (`resolved` or
 * `denied`) and falls on or after the claim date.
 */
@PayloadRule(
  "resolvedOnStatus",
  (dto) => resolvedOnFitsStatus(dto.resolvedOn, dto.status ?? "open"),
  "resolvedOn needs a status of resolved or denied",
)
@PayloadRule(
  "resolvedOnAfterClaim",
  (dto) => resolvedOnFitsClaimDate(dto.resolvedOn, dto.claimDate),
  "resolvedOn must be on or after claimDate",
)
export class CreateWarrantyClaimDto extends WarrantyClaimFieldsDto {}
