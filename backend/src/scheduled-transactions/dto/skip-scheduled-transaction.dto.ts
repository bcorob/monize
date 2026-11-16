import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsUUID, ValidateIf } from "class-validator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

export class SkipScheduledTransactionDto {
  @ApiProperty({
    description:
      "The occurrence the client is skipping, YYYY-MM-DD: the override's date when an override moved it, else the due date. Refused with 409 once it is no longer the due occurrence.",
    example: "2026-09-01",
  })
  @IsCalendarDate()
  expectedOccurrenceDate: string;

  @ApiPropertyOptional({
    description:
      "Id of the override the client saw on that occurrence, or null when it saw none. Refused with 409 when an override was created, replaced or removed since.",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsUUID()
  expectedOverrideId?: string | null;
}
