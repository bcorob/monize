import { PartialType } from "@nestjs/mapped-types";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsBoolean } from "class-validator";
import { CreateScheduledTransactionDto } from "./create-scheduled-transaction.dto";

export class UpdateScheduledTransactionDto extends PartialType(
  CreateScheduledTransactionDto,
) {
  // Update-only intent marker for the parent investment FX rate (issue #1167
  // R11-F1). The form resends the whole object, so numeric equality cannot tell
  // an explicit re-entry from a passive round-trip: when the user actually edits
  // the rate the client sets this true, and the server stamps the current
  // settlement pair even if the value equals the stored one -- honouring a rate
  // re-entered for a since-changed pair. Absent/false keeps the conservative
  // behaviour (an unchanged rate keeps its stored pair, so a stale one is still
  // caught at posting rather than re-blessed).
  @ApiPropertyOptional({
    description:
      "The supplied investmentExchangeRate is a deliberate value for the current settlement pair",
  })
  @IsOptional()
  @IsBoolean()
  investmentExchangeRateExplicit?: boolean;
}
