import { PartialType } from "@nestjs/swagger";

import { PayloadRule } from "./create-warranty.dto";
import {
  WarrantyClaimFieldsDto,
  resolvedOnFitsClaimDate,
  resolvedOnFitsStatus,
} from "./create-warranty-claim.dto";

/**
 * `PATCH /warranties/:id/claims/:claimId`. Every field is optional. The two
 * rules are checked here only where the payload carries both halves; the
 * service checks them again against the stored row merged with the payload,
 * which is the shape that is written.
 */
@PayloadRule(
  "resolvedOnStatus",
  (dto) =>
    dto.status === undefined ||
    resolvedOnFitsStatus(dto.resolvedOn, dto.status),
  "resolvedOn needs a status of resolved or denied",
)
@PayloadRule(
  "resolvedOnAfterClaim",
  (dto) => resolvedOnFitsClaimDate(dto.resolvedOn, dto.claimDate),
  "resolvedOn must be on or after claimDate",
)
export class UpdateWarrantyClaimDto extends PartialType(
  WarrantyClaimFieldsDto,
) {}
