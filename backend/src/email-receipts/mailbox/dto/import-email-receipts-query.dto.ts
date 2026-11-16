import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";

export const IMPORT_PROCESS_VALUES = ["true", "false"] as const;

/**
 * Query of `POST /email-receipts/mailbox/import`. `process=false` stores the
 * rows and leaves them for a later processing run (the browser sends one
 * request per part of a large archive and processes once at the end). A query
 * value is a string; anything but the two literals, a repeated key included, is
 * refused.
 */
export class ImportEmailReceiptsQueryDto {
  @ApiPropertyOptional({
    enum: IMPORT_PROCESS_VALUES,
    default: "true",
    description:
      "false: only store the emails; processing the stored emails is left to the caller.",
  })
  @IsOptional()
  @IsIn(IMPORT_PROCESS_VALUES)
  process?: (typeof IMPORT_PROCESS_VALUES)[number];
}
